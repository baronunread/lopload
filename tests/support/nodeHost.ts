// The test Host: real HTTP, a real temp directory, real bytes on disk.
//
// This is the *entire* substitution surface of the test suite. Everything above
// it — LoploadServices, the TransferEngine, the S3 client, SigV4 signing, the
// React UI — is the same code the shipped app runs. Nothing here simulates
// storage or transfers; MinIO does the former and the real engine does the
// latter.
//
// What each member replaces, and why it has to be replaced at all:
//   fetch     - the Rust fast path needs a webview; native fetch is the same
//               protocol over the same wire (the Rust path is covered instead
//               by the in-app self-test and by cargo test).
//   keychain  - the OS keychain prompts, and would pollute the real login
//               keychain with test entries.
//   stores    - SQLite here is @tauri-apps/plugin-sql, an IPC call.
//   files     - the reader/writer are the same interfaces the engine consumes;
//               only the implementation swaps (node:fs instead of IPC).
//   dialogs   - a native picker can't be clicked by a test, so tests script it.
//   tray/shell/notify - OS surfaces with nothing to assert against; these
//               record their calls so tests can assert on them instead.
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryConnectionStore, MemoryTransferStore } from "../../src/lib/stores/memory";
import { DEFAULT_TUNING } from "../../src/lib/tuning";
import type { ConnectionStore, Credentials, TransferStore, TransferTuning } from "../../src/lib/types";
import type { Host, TrayStatus, TrayUploadTarget } from "../../src/services/host";
import { nativeFetch } from "../setup";
import { localFileReader, localFileWriter } from "./localFiles";

/** Everything the Host did, recorded — so a test can assert on OS surfaces
 * (tray, notifications, Finder) that have no DOM and no bucket to inspect. */
export interface HostRecord {
  trayStatus: TrayStatus[];
  trayConnections: TrayUploadTarget[][];
  trayProgress: (number | null)[];
  badgeCounts: (number | null)[];
  notifications: Array<{ title: string; body: string }>;
  opened: string[];
  revealed: string[];
  /** Timestamps of each installAndRelaunch() call — there's nothing else to
   * observe about it (it would tear down the real process). */
  installAndRelaunchCalls: number[];
}

/** What the test scripts *into* the host: the answers native dialogs would
 * have given, and the ability to fire a drag-and-drop. */
export interface HostControl {
  /** Paths the next pickFiles() call returns. */
  filesToPick: string[];
  /** Path the next pickSaveDestination() returns; null means "user cancelled". */
  saveDestination: string | null;
  /** Path the next pickDirectory() returns; null means "user cancelled". */
  directoryToPick: string | null;
  /** Version the next checkForUpdate() reports; null means "up to date". */
  availableUpdate: string | null;
  /** Simulates the user dropping these native paths onto the window. */
  dropFiles(paths: string[]): void;
}

export interface NodeHost {
  host: Host;
  record: HostRecord;
  control: HostControl;
  /** A real, empty directory on disk. Uploads read from here; downloads land here. */
  workdir: string;
}

export async function createNodeHost(): Promise<NodeHost> {
  const workdir = await mkdtemp(join(tmpdir(), "lopload-test-"));

  const record: HostRecord = {
    trayStatus: [],
    trayConnections: [],
    trayProgress: [],
    badgeCounts: [],
    notifications: [],
    opened: [],
    revealed: [],
    installAndRelaunchCalls: [],
  };

  const credentials = new Map<string, Credentials>();
  const connections: ConnectionStore = new MemoryConnectionStore();
  const transfers: TransferStore = new MemoryTransferStore();

  const settings = {
    autoUpdate: true,
    downloadDir: null as string | null,
    tuning: DEFAULT_TUNING as TransferTuning,
    lastConnectionId: null as string | null,
  };

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
    fetch: nativeFetch,

    keychain: {
      get: async (id) => credentials.get(id) ?? null,
      set: async (id, creds) => void credentials.set(id, creds),
      delete: async (id) => void credentials.delete(id),
    },

    stores: {
      connections: async () => connections,
      transfers: async () => transfers,
    },

    files: {
      reader: localFileReader,
      writer: localFileWriter,
      readDir: async (path) => {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      },
      isDirectory: async (path) => (await stat(path)).isDirectory(),
      size: async (path) => (await stat(path)).size,
      tempDir: async () => workdir,
      join: async (dir, child) => join(dir, child),
    },

    dialogs: {
      pickFiles: async () => control.filesToPick,
      pickSaveDestination: async () => control.saveDestination,
      pickDirectory: async () => control.directoryToPick,
    },

    shell: {
      openPath: async (path) => void record.opened.push(path),
      revealItemInDir: async (path) => void record.revealed.push(path),
    },

    tray: {
      setStatus: (status) => void record.trayStatus.push(status),
      setConnections: (targets) => void record.trayConnections.push(targets),
      setProgress: (fraction) => void record.trayProgress.push(fraction),
      setBadgeCount: (count) => void record.badgeCounts.push(count),
      onUploadFilesRequested: () => () => {},
    },

    settings: {
      isAutoUpdateEnabled: async () => settings.autoUpdate,
      setAutoUpdateEnabled: async (enabled) => void (settings.autoUpdate = enabled),
      getDefaultDownloadDir: async () => settings.downloadDir,
      setDefaultDownloadDir: async (path) => void (settings.downloadDir = path),
      getTransferTuning: async () => settings.tuning,
      setTransferTuning: async (tuning) => void (settings.tuning = tuning),
      getLastConnectionId: async () => settings.lastConnectionId,
      setLastConnectionId: async (id) => void (settings.lastConnectionId = id),
    },

    updates: {
      checkForUpdate: async () => control.availableUpdate,
      installAndRelaunch: async () => void record.installAndRelaunchCalls.push(Date.now()),
    },

    notify: async (title, body) => void record.notifications.push({ title, body }),

    onFileDrop: (cb) => {
      dropSubscribers.add(cb);
      return () => void dropSubscribers.delete(cb);
    },

    initLogSink: async () => {},
  };

  return { host, record, control, workdir };
}
