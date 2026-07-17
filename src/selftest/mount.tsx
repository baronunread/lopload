// Runner B: the same tests/scenarios/* list as `bun test tests/app.test.ts`
// (Runner A), run inside the real Tauri binary — real webview, real Rust IPC
// (fasthttp's `http_send`, fastfs's `write_at`), real MinIO. This is what
// replaces "test it by hand against a real bucket": `bun run selftest`
// launches the actual app, this module drives it, and nothing here simulates
// anything the production app doesn't really do.
//
// The Host is createTauriHost() (src/services/host.tauri.ts) — the exact
// object App.tsx hands the UI — decorated in two ways, never replaced:
//   - dialogs is fully scripted. A native OS file/save/directory picker opens
//     as a modal outside the webview's DOM, so nothing running inside the
//     webview can click it; scripting the answers (like the Node host does,
//     see tests/support/nodeHost.ts) is the one substitution this file makes.
//   - tray/shell/notify/onFileDrop still make their real calls — the
//     decoration only *also* records them into `record`, so scenarios get the
//     same HostControl/HostRecord assertion surface the Node host offers.
// fetch, fs, keychain, stores and settings are untouched: real Rust HTTP,
// real disk, real OS keychain, real SQLite — though the db and settings
// files are selftest-scoped ones, so scenario resets never touch the state
// the real app has saved (see loadDatabase / src/tauri/settings.ts).
//
// Import boundary: everything this file (transitively) imports ends up in the
// production Vite bundle's module graph *unless* main.tsx's dynamic
// import("./selftest/mount") is dead-code-eliminated, which only happens when
// VITE_LOPLOAD_SELFTEST is statically absent at build time (see main.tsx).
// So nothing here may import a node-only module — that's why the BucketProbe
// comes from tests/support/bucketProbe.ts (a plain S3Client wrapper) rather
// than tests/support/storage.ts or nodeHost.ts, both of which shell out to
// docker and touch node:fs. Type-only imports from those two are fine: they
// vanish at the esbuild/Rollup layer and never reach the bundle.
import "../../tests/support/noActEnv"; // must precede the @testing-library/react import

import { invoke } from "@tauri-apps/api/core";
import { mkdir, readFile as tauriReadFile, writeFile } from "@tauri-apps/plugin-fs";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createS3Client } from "../lib/s3/client";
import { createTauriHost } from "../services/host.tauri";
import type { Host, TrayStatus, TrayUploadTarget } from "../services/host";
import { createAppServices } from "../services/appServices";
import { AppShell } from "../ui/AppShell";
import { ServicesProvider } from "../ui/services";
import { bucketProbe, type BucketProbe } from "../../tests/support/bucketProbe";
import { allScenarios } from "../../tests/scenarios";
import type { Expect, Scenario, ScenarioCtx } from "../../tests/scenarios/types";
import type { HostControl, HostRecord } from "../../tests/support/nodeHost";

/** The connection id/name this run uses. The SQLite db and settings file are
 * selftest-scoped (lopload-selftest.db / settings-selftest.json — see
 * loadDatabase and src/tauri/settings.ts), so wiping stores between scenarios
 * can't touch the connections the real app has saved. The OS keychain is the
 * one shared surface left: entries live under the same service, so this id
 * stays deliberately distinctive and is deleted after the run. */
const CONNECTION_ID = "lopload-selftest";
const CONNECTION_NAME = "Lopload Selftest";

interface SelftestEnv {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Key prefix the whole run is confined to — empty for a MinIO bucket of its
   * own, `lopload-test/<run>/` against a real provider, where this run is a
   * guest in somebody's real bucket (same contract as Bucket.prefix in
   * tests/support/storage.ts). */
  prefix: string;
}

function readEnv(): SelftestEnv {
  const env = import.meta.env;
  const endpoint = env.VITE_LOPLOAD_SELFTEST_ENDPOINT;
  const bucket = env.VITE_LOPLOAD_SELFTEST_BUCKET;
  const accessKey = env.VITE_LOPLOAD_SELFTEST_ACCESS_KEY;
  const secretKey = env.VITE_LOPLOAD_SELFTEST_SECRET_KEY;
  const region = env.VITE_LOPLOAD_SELFTEST_REGION || "us-east-1";
  const prefix = env.VITE_LOPLOAD_SELFTEST_PREFIX || "";
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error(
      "Missing VITE_LOPLOAD_SELFTEST_* env vars — this entry point only runs " +
        "via `bun run selftest`, which sets them.",
    );
  }
  return { endpoint, bucket, region, accessKey, secretKey, prefix };
}

/** Prints a line the self-test runner can key on. `console.log` alone isn't
 * enough: the webview's console doesn't reach the terminal `bunx tauri dev`
 * runs in, so the line also goes to Rust's stdout via a debug-only command
 * (src-tauri/src/selftest.rs), which `scripts/selftest.ts` actually reads. */
function report(line: string): void {
  console.log(line);
  void invoke("selftest_log", { line }).catch((err) => {
    console.error("selftest_log invoke failed", err);
  });
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** The Expect implementation ScenarioCtx needs. Deliberately tiny — scenarios
 * only use a handful of matchers (see tests/scenarios/types.ts), and this
 * has to have zero dependency on bun:test, which doesn't exist in a webview. */
const expect: Expect = (actual: unknown) => ({
  toBe(expected) {
    if (!Object.is(actual, expected)) {
      throw new Error(`expected ${stringify(actual)} to be ${stringify(expected)}`);
    }
  },
  toEqual(expected) {
    if (!deepEqual(actual, expected)) {
      throw new Error(`expected ${stringify(actual)} to equal ${stringify(expected)}`);
    }
  },
  toBeNull() {
    if (actual !== null) throw new Error(`expected ${stringify(actual)} to be null`);
  },
  toContain(expected) {
    const ok =
      typeof actual === "string"
        ? actual.includes(String(expected))
        : Array.isArray(actual) && actual.includes(expected);
    if (!ok) throw new Error(`expected ${stringify(actual)} to contain ${stringify(expected)}`);
  },
  toBeGreaterThan(expected) {
    if (!(typeof actual === "number" && actual > expected)) {
      throw new Error(`expected ${stringify(actual)} to be greater than ${expected}`);
    }
  },
});

/** Same contract as tests/support/appHarness.ts's waitFor — duplicated rather
 * than imported, because appHarness.ts pulls in node:fs/promises. */
async function waitFor(check: () => void | Promise<void>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error("waitFor timed out");
}

function emptyRecord(): HostRecord {
  return {
    trayStatus: [],
    trayConnections: [],
    trayProgress: [],
    badgeCounts: [],
    notifications: [],
    opened: [],
    revealed: [],
    installAndRelaunchCalls: [],
  };
}

function resetRecord(record: HostRecord): void {
  record.trayStatus.length = 0;
  record.trayConnections.length = 0;
  record.trayProgress.length = 0;
  record.badgeCounts.length = 0;
  record.notifications.length = 0;
  record.opened.length = 0;
  record.revealed.length = 0;
}

/** Builds the self-test Host: createTauriHost(), dialogs scripted, everything
 * else the real thing (see the module comment for why each piece is shaped
 * this way). */
function buildHost(): { host: Host; control: HostControl; record: HostRecord } {
  const base = createTauriHost();
  const record = emptyRecord();
  const dropSubscribers = new Set<(paths: string[]) => void>();

  const control: HostControl = {
    filesToPick: [],
    saveDestination: null,
    directoryToPick: null,
    availableUpdate: null,
    dropFiles(paths) {
      for (const fn of dropSubscribers) fn(paths);
    },
  };

  const host: Host = {
    ...base,

    // The one legitimate substitution — see the module comment.
    dialogs: {
      pickFiles: async () => control.filesToPick,
      pickSaveDestination: async () => control.saveDestination,
      pickDirectory: async () => control.directoryToPick,
    },

    // Real Tauri calls, decorated only to also populate `record`.
    tray: {
      setStatus: (status: TrayStatus) => {
        record.trayStatus.push(status);
        base.tray.setStatus(status);
      },
      setConnections: (targets: TrayUploadTarget[]) => {
        record.trayConnections.push(targets);
        base.tray.setConnections(targets);
      },
      setProgress: (fraction) => {
        record.trayProgress.push(fraction);
        base.tray.setProgress(fraction);
      },
      setBadgeCount: (count) => {
        record.badgeCounts.push(count);
        base.tray.setBadgeCount(count);
      },
      onUploadFilesRequested: base.tray.onUploadFilesRequested,
    },

    shell: {
      openPath: async (path) => {
        record.opened.push(path);
        await base.shell.openPath(path);
      },
      revealItemInDir: async (path) => {
        record.revealed.push(path);
        await base.shell.revealItemInDir(path);
      },
    },

    notify: async (title, body) => {
      record.notifications.push({ title, body });
      await base.notify(title, body);
    },

    // Real OS drag-drop still fires (useful if someone's watching the app
    // window while this runs); control.dropFiles additionally lets a
    // scenario fire a synthetic drop the way it fires a scripted picker
    // answer, since a real OS drop can't be triggered from inside the
    // webview any more than a real OS dialog can.
    onFileDrop: (cb) => {
      dropSubscribers.add(cb);
      const unlistenReal = base.onFileDrop(cb);
      return () => {
        dropSubscribers.delete(cb);
        unlistenReal();
      };
    },

    // Scripted like the Node host: hitting the real updater endpoint over
    // the network on every self-test run would be slow and beside the point.
    updates: {
      checkForUpdate: async () => control.availableUpdate,
      downloadUpdate: async (_onProgress: (percent: number) => void) => {},
      relaunchApp: base.updates.relaunchApp,
      installAndRelaunch: base.updates.installAndRelaunch,
    },
  };

  return { host, control, record };
}

/** A real, empty directory under the Tauri temp dir — the in-app equivalent
 * of nodeHost's mkdtemp(). */
async function makeWorkdir(_host: Host): Promise<string> {
  // Under /tmp, not the OS temp dir. This runs through @tauri-apps/plugin-fs,
  // which is governed by the capability scope in capabilities/default.json —
  // and that scope already permits /tmp/** (for drag-drop), whereas the macOS
  // temp dir (/var/folders/…) is not in it. Using /tmp keeps the selftest from
  // forcing a capability grant into the shipped app that the app itself never
  // needs. (The app's own temp writes go through the write_at command, which
  // isn't scope-governed, so it's unaffected either way.)
  const dir = `/tmp/lopload-selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Empties the connection and transfer tables between scenarios.
 *
 * Runner A gets this for free — each test builds a fresh nodeHost with fresh
 * in-memory stores. Here the stores are the app's real SQLite database, and it
 * lives as long as the process, so without this every scenario inherits the last
 * one's transfers. A new TransferEngine calls resumePending() on construction
 * and would faithfully pick those back up, re-running uploads whose local files
 * and bucket objects are already gone.
 */
async function resetStores(host: Host): Promise<void> {
  const [connections, transfers] = await Promise.all([
    host.stores.connections(),
    host.stores.transfers(),
  ]);
  const conns = await connections.list();
  await Promise.all(
    conns.map(async (conn) => {
      const connTransfers = await transfers.list(conn.id);
      await Promise.all(connTransfers.map((transfer) => transfers.delete(transfer.id)));
      await connections.delete(conn.id);
    }),
  );
}

async function runScenario(
  scenario: Scenario,
  host: Host,
  control: HostControl,
  record: HostRecord,
  probe: BucketProbe,
  env: SelftestEnv,
): Promise<{ ok: boolean; error?: string }> {
  // Reset the scriptable/observed surface so one scenario's leftovers can't
  // leak into the next — the in-app equivalent of a fresh nodeHost per test.
  control.filesToPick = [];
  control.saveDestination = null;
  control.directoryToPick = null;
  control.availableUpdate = null;
  resetRecord(record);
  await probe.clear();
  await resetStores(host);

  const workdir = await makeWorkdir(host);
  const services = createAppServices(host);

  await services.connections.save(
    {
      id: CONNECTION_ID,
      name: CONNECTION_NAME,
      endpoint: env.endpoint,
      bucket: env.bucket,
      region: env.region,
      // The run's prefix is the app's starting folder, exactly as Runner A
      // does it (tests/support/appHarness.ts) — scenarios see the same tree
      // whether the run owns the bucket or a prefix inside one.
      lastPrefix: env.prefix,
      createdAt: Date.now(),
    },
    { accessKey: env.accessKey, secretKey: env.secretKey },
  );
  await host.settings.setLastConnectionId(CONNECTION_ID);

  // Seed before render: the app lists the current folder once on mount and never
  // polls, so anything arranged after this point would race that listing and
  // might never appear. Same ordering Runner A uses — see Scenario.arrange.
  await scenario.arrange?.(probe);

  render(
    <ServicesProvider value={services}>
      <AppShell />
    </ServicesProvider>,
  );

  try {
    const ctx: ScenarioCtx = {
      services,
      bucket: probe,
      connectionId: CONNECTION_ID,
      prefix: env.prefix,
      workdir,
      control,
      record,
      user: userEvent.setup(),
      expect,
      waitFor,
      async makeLocalFile(name, bytes) {
        const path = `${workdir}/${name}`;
        const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
        await writeFile(path, data);
        return path;
      },
      async readLocalFile(path) {
        return await tauriReadFile(path);
      },
    };

    await scenario.run(ctx);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    return { ok: false, error: message };
  } finally {
    cleanup();
    await services.dispose();
  }
}

async function runSelftest(): Promise<void> {
  const env = readEnv();
  const { host, control, record } = buildHost();

  const probeClient = createS3Client(
    { endpoint: env.endpoint, region: env.region },
    { accessKey: env.accessKey, secretKey: env.secretKey },
    host.fetch,
  );
  // Scoped to the run's prefix, so against a real provider neither an assert
  // nor a clear() can name a key outside lopload-test/<run>/.
  const probe = bucketProbe(probeClient, env.bucket, env.prefix);

  const scenarios = allScenarios.filter((s) => !s.nodeOnly);
  report(`SELFTEST_START total=${scenarios.length}`);

  let passed = 0;
  let failed = 0;

  for (const scenario of scenarios) {
    const result = await runScenario(scenario, host, control, record, probe, env);
    if (result.ok) {
      passed += 1;
      report(`SELFTEST_SCENARIO PASS ${scenario.name}`);
    } else {
      failed += 1;
      report(`SELFTEST_SCENARIO FAIL ${scenario.name} :: ${result.error}`);
    }
  }

  // Best-effort: against a real provider the run is a guest in somebody's
  // bucket — leave its prefix the way it was found. (Runner A does the same
  // in appHarness dispose; MinIO runs skip it, the bucket is theirs alone.)
  if (env.prefix) {
    try {
      await probe.clear();
    } catch (err) {
      console.warn("selftest: failed to clean up the run's key prefix", err);
    }
  }

  // Best-effort: the db and settings are selftest-scoped, but the OS
  // keychain is the real one — don't leave test credentials sitting there
  // after the run, regardless of pass/fail.
  try {
    const store = await host.stores.connections();
    await store.delete(CONNECTION_ID);
  } catch (err) {
    console.warn("selftest: failed to clean up the test connection", err);
  }
  try {
    await host.keychain.delete(CONNECTION_ID);
  } catch (err) {
    console.warn("selftest: failed to clean up the test credentials", err);
  }

  const ok = failed === 0;
  report(
    `SELFTEST_RESULT ${ok ? "PASS" : "FAIL"} total=${scenarios.length} passed=${passed} failed=${failed}`,
  );

  await invoke("selftest_exit", { code: ok ? 0 : 1 }).catch((err) => {
    console.error("selftest_exit invoke failed — the app will not close itself", err);
  });
}

void runSelftest().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  report(`SELFTEST_RESULT FAIL total=0 passed=0 failed=0 :: fatal: ${message}`);
  void invoke("selftest_exit", { code: 1 }).catch(() => {});
});
