// One shared suite exercising the AppServices contract (src/ui/services.ts)
// against every implementation we have, so demoServices (src/ui/demoServices.ts)
// and the real engine-backed services (src/services/real.ts, here wired
// entirely in-memory) can't silently drift apart. Adding a third
// implementation later means adding one more entry to IMPLEMENTATIONS below.
//
// Each test creates its own connection with a random id/bucket so the two
// implementations' module-level, session-lifetime state (demoServices'
// module maps; RealServices' cached stores/engines) never leaks between
// tests or between implementations.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createDemoServices } from "../../src/ui/demoServices";
import type { AppServices } from "../../src/ui/services";
import type { Connection, EngineEvent, Transfer } from "../../src/lib/types";
import {
  fakeLocalFiles,
  fakeS3,
  getRealServices,
  installRealServicesMocks,
  uninstallRealServicesMocks,
} from "./support/realServicesHarness";

// Installed/removed around the whole file (not at module load time) — see
// realServicesHarness.ts for why `mock.module`'s process-wide reach makes
// this ordering matter for other test files.
beforeAll(() => {
  installRealServicesMocks();
});

afterAll(() => {
  fakeS3.reset();
  uninstallRealServicesMocks();
});

interface Implementation {
  name: string;
  services(): Promise<AppServices>;
  /** Populates `localPath` with `bytes` so an upload can read it (demo never
   * reads real bytes; real reads from the fake fs backing it). */
  seedLocalFile(localPath: string, bytes: Uint8Array): void;
  /** Reads back a path written by a completed download. */
  readLocalFile(localPath: string): Uint8Array | undefined;
}

const IMPLEMENTATIONS: Implementation[] = [
  {
    name: "demoServices",
    services: async () => createDemoServices(),
    seedLocalFile() {
      // demoServices' transfers are simulated timers — they never touch the
      // filesystem, so there's nothing to seed.
    },
    readLocalFile() {
      return undefined;
    },
  },
  {
    name: "real services (memory-backed)",
    services: async () => getRealServices(),
    seedLocalFile(localPath, bytes) {
      fakeLocalFiles.set(localPath, bytes);
    },
    readLocalFile(localPath) {
      return fakeLocalFiles.get(localPath);
    },
  },
];

function uniqueId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

async function makeConnection(services: AppServices): Promise<Connection> {
  const conn: Connection = {
    id: uniqueId("conn"),
    name: "Conformance test storage",
    endpoint: "https://conformance.example.test",
    bucket: uniqueId("bucket"),
    lastPrefix: "",
    createdAt: Date.now(),
  };
  await services.connections.save(conn, { accessKey: "ak", secretKey: "sk" });
  return conn;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForTerminal(
  services: AppServices,
  connectionId: string,
  transferId: string,
): Promise<Transfer> {
  await waitUntil(async () => {
    const transfers = await services.engine.listTransfers(connectionId);
    const t = transfers.find((x) => x.id === transferId);
    return t !== undefined && (t.state.kind === "uploaded" || t.state.kind === "downloaded" || t.state.kind === "failed");
  });
  const transfers = await services.engine.listTransfers(connectionId);
  return transfers.find((t) => t.id === transferId)!;
}

describe.each(IMPLEMENTATIONS)("service conformance — $name", (impl) => {
  test("connections: save, list, setLastPrefix, delete", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);

    const afterSave = await services.connections.list();
    expect(afterSave.some((c) => c.id === conn.id)).toBe(true);

    await services.connections.setLastPrefix(conn.id, "photos/");
    const afterPrefix = await services.connections.list();
    expect(afterPrefix.find((c) => c.id === conn.id)?.lastPrefix).toBe("photos/");

    await services.connections.delete(conn.id);
    const afterDelete = await services.connections.list();
    expect(afterDelete.some((c) => c.id === conn.id)).toBe(false);
  });

  test("browser.list: empty folder returns no entries", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);

    const entries = await services.browser.list(conn.id, "");
    expect(entries).toEqual([]);
  });

  test("browser.createFolder makes a folder entry with a slash-free display name, not visible to listFilesRecursive", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);

    await services.browser.createFolder(conn.id, "", "Vacation");

    const entries = await services.browser.list(conn.id, "");
    const folder = entries.find((e) => e.kind === "folder");
    expect(folder).toBeDefined();
    expect(folder!.name).toBe("Vacation");
    expect(folder!.name.endsWith("/")).toBe(false);
    expect(folder!.key).toBe("Vacation/");

    const files = await services.browser.listFilesRecursive(conn.id, "Vacation/");
    expect(files).toEqual([]);
  });

  test("browser.getThumbnailUrl returns null for a non-media file", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const url = await services.browser.getThumbnailUrl(conn.id, "notes.txt");
    expect(url).toBeNull();
  });

  test("engine.enqueueFiles: an upload reaches the uploaded terminal state and emits transfer-updated events", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const localPath = `/local/${uniqueId("upload")}.txt`;
    const bytes = new TextEncoder().encode("hello from the conformance suite");
    impl.seedLocalFile(localPath, bytes);

    const events: EngineEvent[] = [];
    const unsubscribe = services.engine.subscribe((e) => events.push(e));

    await services.engine.enqueueFiles(conn.id, "docs/", [
      { path: localPath, name: "note.txt", size: bytes.length },
    ]);

    await waitUntil(async () => {
      const transfers = await services.engine.listTransfers(conn.id);
      return transfers.some((t) => t.state.kind === "uploaded");
    });

    const transfers = await services.engine.listTransfers(conn.id);
    const uploaded = transfers.find((t) => t.state.kind === "uploaded")!;
    expect(uploaded).toBeDefined();
    expect(uploaded.key).toBe("docs/note.txt");
    expect(uploaded.direction).toBe("upload");

    const relevant = events.filter(
      (e) => e.type === "transfer-updated" && e.transfer.id === uploaded.id,
    ) as Array<{ type: "transfer-updated"; transfer: Transfer }>;
    expect(relevant.length).toBeGreaterThan(0);
    expect(relevant[relevant.length - 1].transfer.state).toEqual({ kind: "uploaded" });

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 1, downloaded: 0, failed: 0 });

    // The uploaded file must now be visible in the folder listing.
    const entries = await services.browser.list(conn.id, "docs/");
    expect(entries.some((e) => e.kind === "file" && e.key === "docs/note.txt")).toBe(true);

    unsubscribe();
  }, 10_000);

  test("engine.enqueueDownloads: a download reaches the downloaded terminal state", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const uploadPath = `/local/${uniqueId("src")}.txt`;
    const bytes = new TextEncoder().encode("round trip me");
    impl.seedLocalFile(uploadPath, bytes);

    const [uploadTransfer] = await Promise.all([
      new Promise<Transfer>((resolve) => {
        const unsubscribe = services.engine.subscribe((e) => {
          if (
            e.type === "transfer-updated" &&
            e.transfer.connectionId === conn.id &&
            e.transfer.state.kind === "uploaded"
          ) {
            unsubscribe();
            resolve(e.transfer);
          }
        });
        void services.engine.enqueueFiles(conn.id, "", [
          { path: uploadPath, name: "roundtrip.txt", size: bytes.length },
        ]);
      }),
    ]);
    expect(uploadTransfer.key).toBe("roundtrip.txt");

    const downloadPath = `/local/${uniqueId("dst")}.txt`;
    await services.engine.enqueueDownloads(conn.id, [
      { key: "roundtrip.txt", localPath: downloadPath, size: bytes.length },
    ]);

    await waitUntil(async () => {
      const transfers = await services.engine.listTransfers(conn.id);
      return transfers.some((t) => t.direction === "download" && t.state.kind === "downloaded");
    });

    const transfers = await services.engine.listTransfers(conn.id);
    const downloaded = transfers.find((t) => t.direction === "download")!;
    expect(downloaded.state).toEqual({ kind: "downloaded" });

    const written = impl.readLocalFile(downloadPath);
    if (written !== undefined) {
      expect(new TextDecoder().decode(written)).toBe("round trip me");
    }
  }, 10_000);

  test("a failed transfer can be retried and can be dismissed", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const localPath = `/local/${uniqueId("upload-fail")}.txt`;
    const bytes = new TextEncoder().encode("this one should fail");
    impl.seedLocalFile(localPath, bytes);

    await services.engine.enqueueFiles(conn.id, "", [
      // "fail" in the key is the shared test hook both implementations honor
      // (see demoServices.ts's runTransfer and tests/unit/support/fakeS3Bucket.ts).
      { path: localPath, name: "please-fail.txt", size: bytes.length },
    ]);

    const failed = await waitForTerminal(
      services,
      conn.id,
      (await services.engine.listTransfers(conn.id))[0].id,
    );
    expect(failed.state.kind).toBe("failed");

    // retry() must accept a failed transfer and run it through the state
    // machine again (queued -> ... -> a terminal state), per PLAN.md's
    // documented "failed" -> "queued" transition.
    const seenAfterRetry: Transfer["state"]["kind"][] = [];
    const unsubscribe = services.engine.subscribe((e) => {
      if (e.type === "transfer-updated" && e.transfer.id === failed.id) {
        seenAfterRetry.push(e.transfer.state.kind);
      }
    });
    await services.engine.retry(failed.id);
    await waitUntil(() => {
      const last = seenAfterRetry[seenAfterRetry.length - 1];
      return last === "uploaded" || last === "failed";
    });
    unsubscribe();
    expect(seenAfterRetry[0]).toBe("queued");

    await services.engine.dismiss(failed.id);
    const afterDismiss = await services.engine.listTransfers(conn.id);
    expect(afterDismiss.some((t) => t.id === failed.id)).toBe(false);
  }, 10_000);

  test("cancel removes a transfer before it settles", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const localPath = `/local/${uniqueId("upload-slow")}.txt`;
    const bytes = new TextEncoder().encode("this one is slow, cancel it");
    impl.seedLocalFile(localPath, bytes);

    await services.engine.enqueueFiles(conn.id, "", [
      // "slow" in the key is the shared test hook (fakeS3Bucket.ts delays
      // it); demoServices is already slow enough via its own simulated
      // timers for this window to be reliable without any special-casing.
      { path: localPath, name: "please-go-slow.txt", size: bytes.length },
    ]);
    const [transfer] = await services.engine.listTransfers(conn.id);

    await services.engine.cancel(transfer.id);

    const afterCancel = await services.engine.listTransfers(conn.id);
    expect(afterCancel.some((t) => t.id === transfer.id)).toBe(false);
  });

  test("browser.copyLink returns a URL", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const link = await services.browser.copyLink(conn.id, "some/file.txt");
    expect(typeof link).toBe("string");
    expect(link.startsWith("http")).toBe(true);
  });

  test("trash: deleting hides an item from listing, shows it in the trash, then restore/delete-now/empty round-trip", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);

    await services.browser.createFolder(conn.id, "", "Vacation");
    const localPath = `/local/${uniqueId("photo")}.jpg`;
    impl.seedLocalFile(localPath, new TextEncoder().encode("photo bytes"));
    await new Promise<void>((resolve) => {
      const unsubscribe = services.engine.subscribe((e) => {
        if (
          e.type === "transfer-updated" &&
          e.transfer.connectionId === conn.id &&
          e.transfer.state.kind === "uploaded"
        ) {
          unsubscribe();
          resolve();
        }
      });
      void services.engine.enqueueFiles(conn.id, "Vacation/", [
        { path: localPath, name: "beach.jpg", size: 11 },
      ]);
    });

    // Deleting the folder must hide every file under it from normal listing,
    // recursive listing, and downloads-all.
    await services.browser.delete(conn.id, "Vacation/");

    const afterDelete = await services.browser.list(conn.id, "");
    expect(afterDelete.some((e) => e.key.startsWith("Vacation"))).toBe(false);
    const recursiveAfterDelete = await services.browser.listFilesRecursive(conn.id, "Vacation/");
    expect(recursiveAfterDelete).toEqual([]);

    const trashed = await services.trash.list(conn.id);
    const vacationItem = trashed.find((t) => t.originalKey === "Vacation/");
    expect(vacationItem).toBeDefined();
    expect(vacationItem!.kind).toBe("folder");

    // Restoring puts it back where normal browsing sees it again.
    await services.trash.restore(conn.id, vacationItem!);
    const afterRestore = await services.browser.list(conn.id, "");
    expect(afterRestore.some((e) => e.key === "Vacation/")).toBe(true);
    const recursiveAfterRestore = await services.browser.listFilesRecursive(conn.id, "Vacation/");
    expect(recursiveAfterRestore.some((f) => f.key === "Vacation/beach.jpg")).toBe(true);
    const trashedAfterRestore = await services.trash.list(conn.id);
    expect(trashedAfterRestore.some((t) => t.originalKey === "Vacation/")).toBe(false);

    // Delete it again, then remove it for good via deleteNow.
    await services.browser.delete(conn.id, "Vacation/");
    const trashedAgain = await services.trash.list(conn.id);
    const vacationAgain = trashedAgain.find((t) => t.originalKey === "Vacation/")!;
    expect(vacationAgain).toBeDefined();
    await services.trash.deleteNow(conn.id, vacationAgain);
    const afterDeleteNow = await services.trash.list(conn.id);
    expect(afterDeleteNow.some((t) => t.originalKey === "Vacation/")).toBe(false);

    // Empty trash clears everything left for this connection.
    const other = await makeConnection(services);
    await services.browser.createFolder(other.id, "", "ToTrash");
    await services.browser.delete(other.id, "ToTrash/");
    expect((await services.trash.list(other.id)).length).toBeGreaterThan(0);
    await services.trash.emptyTrash(other.id);
    expect(await services.trash.list(other.id)).toEqual([]);
  }, 10_000);

  test("trash: restoring a file onto an occupied path throws and leaves the trashed copy in place", async () => {
    const services = await impl.services();
    const conn = await makeConnection(services);
    const localPath = `/local/${uniqueId("note")}.txt`;
    impl.seedLocalFile(localPath, new TextEncoder().encode("v1"));

    await new Promise<void>((resolve) => {
      const unsubscribe = services.engine.subscribe((e) => {
        if (
          e.type === "transfer-updated" &&
          e.transfer.connectionId === conn.id &&
          e.transfer.state.kind === "uploaded"
        ) {
          unsubscribe();
          resolve();
        }
      });
      void services.engine.enqueueFiles(conn.id, "", [
        { path: localPath, name: "note.txt", size: 2 },
      ]);
    });
    await services.browser.delete(conn.id, "note.txt");

    // Something new now lives at the same path the trashed copy came from.
    const localPath2 = `/local/${uniqueId("note2")}.txt`;
    impl.seedLocalFile(localPath2, new TextEncoder().encode("v2"));
    await new Promise<void>((resolve) => {
      const unsubscribe = services.engine.subscribe((e) => {
        if (
          e.type === "transfer-updated" &&
          e.transfer.connectionId === conn.id &&
          e.transfer.state.kind === "uploaded"
        ) {
          unsubscribe();
          resolve();
        }
      });
      void services.engine.enqueueFiles(conn.id, "", [
        { path: localPath2, name: "note.txt", size: 2 },
      ]);
    });

    const trashed = await services.trash.list(conn.id);
    const item = trashed.find((t) => t.originalKey === "note.txt")!;
    expect(item).toBeDefined();

    await expect(services.trash.restore(conn.id, item)).rejects.toThrow();

    // The trashed copy must still be there afterwards.
    const trashedAfter = await services.trash.list(conn.id);
    expect(trashedAfter.some((t) => t.originalKey === "note.txt")).toBe(true);
  }, 10_000);

  test("keychain.testConnection: succeeds for a reachable target, fails for an unreachable one", async () => {
    const services = await impl.services();

    const ok = await services.keychain.testConnection({
      name: "ok",
      endpoint: "https://reachable.example.test",
      bucket: uniqueId("bucket"),
      accessKey: "ak",
      secretKey: "sk",
    });
    expect(ok.ok).toBe(true);
    expect(ok.message.length).toBeGreaterThan(0);

    // Each implementation has its own trigger for "unreachable" (demoServices
    // keys off the endpoint; the real backend's fake S3 keys off the bucket
    // name — see fakeS3Bucket.ts) — both must resolve `ok: false` rather than
    // throwing, with a plain-language message.
    const fail = await services.keychain.testConnection({
      name: "fail",
      endpoint: "https://fail.example.test",
      bucket: "fail-bucket",
      accessKey: "ak",
      secretKey: "sk",
    });
    expect(fail.ok).toBe(false);
    expect(fail.message.length).toBeGreaterThan(0);
  });
});

describe("service conformance — scope notes", () => {
  test("pickFiles/pickSaveDestination/pickDownloadDirectory/openFile/onFileDrop/setBadgeCount/notify are intentionally out of scope", () => {
    // These AppServices members are thin OS-integration entry points (native
    // file dialogs, OS drag-drop, dock badge, OS notifications) rather than
    // backend state the two implementations could drift on independently —
    // demoServices returns fixed canned values and real.ts opens real native
    // dialogs, so there's no shared "contract behavior" to assert equal.
    // They're already covered at the UI layer by tests/unit/ui/fakeServices.ts
    // consumers (e.g. RemoteBrowser.test.tsx).
    expect(true).toBe(true);
  });
});
