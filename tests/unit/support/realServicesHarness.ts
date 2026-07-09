// Builds the *real* AppServices implementation (src/services/real.ts) fully
// in-memory, for the service conformance suite: SQLite stores swapped for
// MemoryConnectionStore/MemoryTransferStore, the OS keychain swapped for a
// Map, the filesystem swapped for an in-memory one, and the S3 client's
// network calls intercepted by aws-sdk-client-mock (see fakeS3Bucket.ts).
//
// `mock.module` is process-global and retroactively affects every consumer
// of a mocked specifier (including other test files that imported it
// earlier) for as long as it's installed — so `installRealServicesMocks()`
// must run in the conformance suite's `beforeAll` (not at module load time,
// when bun has already imported every other test file) and
// `uninstallRealServicesMocks()` must run in its `afterAll`, restoring
// tests/unit/s3-listing.test.ts and friends to the real modules.
//
// `mock.restore()` only reliably undoes the *last* `mock.module()` call made
// in a run (bun 1.3.4) — with this many specifiers mocked, it silently
// leaves earlier ones (e.g. "../lib/s3/client") mocked for the rest of the
// process. So teardown here re-registers each specifier back to its real,
// statically-captured module instead of relying on `mock.restore()`.
import { mock } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import * as tauriCore from "@tauri-apps/api/core";
import * as tauriEvent from "@tauri-apps/api/event";
import * as tauriPath from "@tauri-apps/api/path";
import * as tauriWebview from "@tauri-apps/api/webview";
import * as tauriDialog from "@tauri-apps/plugin-dialog";
import * as tauriFsPlugin from "@tauri-apps/plugin-fs";
import * as tauriNotification from "@tauri-apps/plugin-notification";
import * as tauriOpener from "@tauri-apps/plugin-opener";

import type { Connection, ConnectionStore, Credentials, TransferStore } from "../../../src/lib/types";
import { MemoryConnectionStore, MemoryTransferStore } from "../../../src/lib/stores/memory";
import * as actualS3Client from "../../../src/lib/s3/client";
import * as actualSqlite from "../../../src/lib/stores/sqlite";
import * as actualKeychain from "../../../src/tauri/keychain";
import * as actualHttp from "../../../src/tauri/http";
import * as actualTray from "../../../src/tauri/tray";
import { installFakeS3 } from "./fakeS3Bucket";
import { createFakeFsModule } from "./fakeFs";

// `import * as ns` bindings are *live* views into the module record —
// `mock.module()` replaces that record in place, so a namespace captured
// this way would reflect our own mock once installed (self-contamination).
// Spreading each one into a plain object here, before any mocking happens,
// takes a real snapshot instead.
const REAL_S3_CLIENT = { ...actualS3Client };
const REAL_SQLITE = { ...actualSqlite };
const REAL_KEYCHAIN = { ...actualKeychain };
const REAL_HTTP = { ...actualHttp };
const REAL_TRAY = { ...actualTray };
const REAL_TAURI_CORE = { ...tauriCore };
const REAL_TAURI_EVENT = { ...tauriEvent };
const REAL_TAURI_PATH = { ...tauriPath };
const REAL_TAURI_WEBVIEW = { ...tauriWebview };
const REAL_TAURI_DIALOG = { ...tauriDialog };
const REAL_TAURI_FS = { ...tauriFsPlugin };
const REAL_TAURI_NOTIFICATION = { ...tauriNotification };
const REAL_TAURI_OPENER = { ...tauriOpener };

const sharedClient = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
});

export const fakeS3 = installFakeS3(sharedClient);

/** Local filesystem backing uploads/downloads — pre-populate a path with
 * bytes before enqueueing an upload from it; read a path back after a
 * download completes. */
export const fakeLocalFiles = new Map<string, Uint8Array>();
const fakeFsModule = createFakeFsModule(fakeLocalFiles);

const credentialsStore = new Map<string, Credentials>();

class MemorySqliteConnectionStore implements ConnectionStore {
  private inner = new MemoryConnectionStore();
  list(): Promise<Connection[]> {
    return this.inner.list();
  }
  get(id: string): Promise<Connection | null> {
    return this.inner.get(id);
  }
  save(conn: Connection): Promise<void> {
    return this.inner.save(conn);
  }
  delete(id: string): Promise<void> {
    return this.inner.delete(id);
  }
  setLastPrefix(id: string, prefix: string): Promise<void> {
    return this.inner.setLastPrefix(id, prefix);
  }
}

class MemorySqliteTransferStore implements TransferStore {
  private inner = new MemoryTransferStore();
  list(connectionId: string) {
    return this.inner.list(connectionId);
  }
  get(id: string) {
    return this.inner.get(id);
  }
  save(t: Parameters<TransferStore["save"]>[0]) {
    return this.inner.save(t);
  }
  delete(id: string) {
    return this.inner.delete(id);
  }
  saveParts(parts: Parameters<TransferStore["saveParts"]>[0]) {
    return this.inner.saveParts(parts);
  }
  listParts(transferId: string) {
    return this.inner.listParts(transferId);
  }
  knownUploadIds(connectionId: string) {
    return this.inner.knownUploadIds(connectionId);
  }
}

let installed = false;
let realServicesModule: typeof import("../../../src/services/real.ts") | null = null;

/** One entry per mocked specifier, pairing its fake with the real module to
 * restore on teardown (see the top-of-file note on `mock.restore()`).
 *
 * `restoreOnTeardown` is only set for specifiers other test files actually
 * import for real (currently just "../lib/s3/client", used directly by
 * tests/unit/s3-listing.test.ts and friends). The Tauri plugin wrappers and
 * the sqlite store are exclusive to src/services/real.ts's import graph, so
 * they're left mocked for the rest of the process — RealServices keeps a
 * background orphan-sweep timer and fire-and-forget engine/notification
 * calls alive after a test finishes, and letting those hit the *real*
 * @tauri-apps/plugin-notification etc. outside a Tauri webview (e.g. under
 * happy-dom, no `window.Notification`) crashes an unrelated, later test. */
const MOCKS: Array<{ specifier: string; fake: () => unknown; real: unknown; restoreOnTeardown?: boolean }> = [
  { specifier: "@tauri-apps/plugin-fs", fake: () => fakeFsModule, real: REAL_TAURI_FS },
  {
    specifier: "@tauri-apps/plugin-dialog",
    fake: () => ({ open: async () => null, save: async () => null }),
    real: REAL_TAURI_DIALOG,
  },
  {
    specifier: "@tauri-apps/plugin-opener",
    fake: () => ({ openPath: async () => {}, revealItemInDir: async () => {} }),
    real: REAL_TAURI_OPENER,
  },
  {
    specifier: "@tauri-apps/plugin-notification",
    fake: () => ({
      isPermissionGranted: async () => true,
      requestPermission: async () => "granted",
      sendNotification: () => {},
    }),
    real: REAL_TAURI_NOTIFICATION,
  },
  {
    specifier: "@tauri-apps/plugin-store",
    fake: () => {
      const stores = new Map<string, Map<string, unknown>>();
      // Minimal LazyStore replacement that avoids the invoke chain.
      class FakeLazyStore {
        private data = new Map<string, unknown>();
        constructor(
          _path: string,
          opts?: { defaults?: Record<string, unknown>; autoSave?: number },
        ) {
          if (opts?.defaults) {
            for (const [k, v] of Object.entries(opts.defaults)) {
              this.data.set(k, v);
            }
          }
        }
        async get<T>(key: string): Promise<T | undefined> {
          return this.data.get(key) as T;
        }
        async set(key: string, value: unknown): Promise<void> {
          this.data.set(key, value);
        }
      }
      return { LazyStore: FakeLazyStore };
    },
    real: null as never,
  },
  { specifier: "@tauri-apps/api/path", fake: () => ({ tempDir: async () => "/fake-tmp", appLogDir: async () => "/fake-logs", join: async (...parts: string[]) => parts.join("/") }), real: REAL_TAURI_PATH },
  {
    specifier: "@tauri-apps/api/webview",
    fake: () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }) }),
    real: REAL_TAURI_WEBVIEW,
  },
  { specifier: "@tauri-apps/api/event", fake: () => ({ listen: async () => () => {} }), real: REAL_TAURI_EVENT },
  { specifier: "@tauri-apps/api/core", fake: () => ({ invoke: async () => undefined }), real: REAL_TAURI_CORE },
  {
    specifier: "../../../src/tauri/keychain",
    fake: () => ({
      keychainSet: async (connectionId: string, credentials: Credentials) => {
        credentialsStore.set(connectionId, credentials);
      },
      keychainGet: async (connectionId: string) => credentialsStore.get(connectionId) ?? null,
      keychainDelete: async (connectionId: string) => {
        credentialsStore.delete(connectionId);
      },
    }),
    real: REAL_KEYCHAIN,
  },
  { specifier: "../../../src/tauri/http", fake: () => ({ tauriFetch: globalThis.fetch }), real: REAL_HTTP },
  {
    specifier: "../../../src/tauri/tray",
    fake: () => ({
      setTrayStatus: () => {},
      setTrayConnections: () => {},
      onUploadFilesRequested: () => () => {},
    }),
    real: REAL_TRAY,
  },
  {
    specifier: "../../../src/lib/stores/sqlite",
    fake: () => ({
      loadDatabase: async () => ({}) as never,
      SqliteConnectionStore: MemorySqliteConnectionStore,
      SqliteTransferStore: MemorySqliteTransferStore,
    }),
    real: REAL_SQLITE,
  },
  {
    specifier: "../../../src/lib/s3/client",
    fake: () => ({ ...REAL_S3_CLIENT, createS3Client: () => sharedClient }),
    real: REAL_S3_CLIENT,
    restoreOnTeardown: true,
  },
];

/** Registers every module mock real.ts's import graph needs. Idempotent —
 * safe to call from a `beforeAll` that may run more than once per process. */
export function installRealServicesMocks(): void {
  if (installed) return;
  installed = true;
  for (const { specifier, fake } of MOCKS) {
    mock.module(specifier, fake);
  }
}

/** Restores the specifiers flagged `restoreOnTeardown` to their real modules
 * (currently just "../lib/s3/client") for the rest of the test run. Doesn't
 * use `mock.restore()` — see the top-of-file note. Everything else stays
 * mocked deliberately (see the comment on `MOCKS`). */
export function uninstallRealServicesMocks(): void {
  if (!installed) return;
  for (const { specifier, real, restoreOnTeardown } of MOCKS) {
    if (restoreOnTeardown) mock.module(specifier, () => real);
  }
  installed = false;
  realServicesModule = null;
}

/** The real AppServices implementation, wired entirely in-memory. A single
 * process-wide instance ("one long-lived session" model) — tests must use
 * unique connection ids/buckets rather than relying on a fresh instance per
 * test. Must only be called after `installRealServicesMocks()`. */
export async function getRealServices() {
  if (!installed) {
    throw new Error("getRealServices() called before installRealServicesMocks()");
  }
  if (!realServicesModule) {
    realServicesModule = await import("../../../src/services/real.ts");
  }
  return realServicesModule.createRealServices();
}
