// The platform boundary — the only things in this app that genuinely cannot
// run outside a Tauri webview.
//
// Everything below this line (src/lib: the engine, the S3 client, the stores)
// already takes its dependencies as arguments, and everything above it
// (src/ui) reaches the world only through AppServices. `Host` closes the last
// gap: it lets src/services/appServices.ts — the wiring layer — be constructed
// against something other than the webview.
//
// Two implementations exist, both real:
//   - createTauriHost()  (src/services/host.tauri.ts)  — the app
//   - createNodeHost()   (tests/support/nodeHost.ts)   — bun test
//
// Keep this interface narrow. Anything with logic in it belongs in
// LoploadServices or src/lib, where it can be tested through both hosts. A
// method earns its place here only if it must talk to the OS or the webview.
import type { FetchFn } from "../lib/s3/http-handler";
import type { LocalFileWriter } from "../lib/s3/download";
import type { LocalFileReader } from "../lib/s3/multipart";
import type {
  ConnectionStore,
  Credentials,
  TransferStore,
  TransferTuning,
} from "../lib/types";
import type { DropDirEntry } from "./dragDropExpand";
import type { TrayStatus, TrayUploadTarget } from "../tauri/tray";

export type { TrayStatus, TrayUploadTarget };

/** Credential storage. The Tauri host uses the OS keychain; the Node host a Map. */
export interface HostKeychain {
  get(connectionId: string): Promise<Credentials | null>;
  set(connectionId: string, credentials: Credentials): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

/** Persistence for connections and transfers. Both stores are resolved lazily
 * and memoized by the host, so LoploadServices can await them freely. */
export interface HostStores {
  connections(): Promise<ConnectionStore>;
  transfers(): Promise<TransferStore>;
}

/** Local-filesystem access. `reader`/`writer` are the same interfaces the
 * engine already consumes (src/lib/s3/{multipart,download}.ts). */
export interface HostFiles {
  reader: LocalFileReader;
  writer: LocalFileWriter;
  readDir(path: string): Promise<DropDirEntry[]>;
  isDirectory(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  tempDir(): Promise<string>;
  join(dir: string, child: string): Promise<string>;
}

/** Native file pickers. These return raw paths — turning them into PickedFiles
 * (stat'ing for size, deriving the display name) is LoploadServices' job, so that
 * logic stays testable. */
export interface HostDialogs {
  /** Multi-select file picker. Empty array when the user cancels. */
  pickFiles(): Promise<string[]>;
  /** Save-as picker. Null when the user cancels. */
  pickSaveDestination(defaultPath: string): Promise<string | null>;
  /** Directory picker. Null when the user cancels. */
  pickDirectory(defaultPath?: string): Promise<string | null>;
}

export interface HostShell {
  openPath(path: string): Promise<void>;
  revealItemInDir(path: string): Promise<void>;
}

/** Fire-and-forget tray updates — none of these can fail in a way the UI
 * should care about, so they don't return promises. */
export interface HostTray {
  setStatus(status: TrayStatus): void;
  setConnections(targets: TrayUploadTarget[]): void;
  setProgress(fraction: number | null): void;
  setBadgeCount(count: number | null): void;
  /** Fires when the user picks a connection from the tray's "Upload files…" submenu. */
  onUploadFilesRequested(cb: (connectionId: string) => void): () => void;
}

export interface HostSettings {
  isAutoUpdateEnabled(): Promise<boolean>;
  setAutoUpdateEnabled(enabled: boolean): Promise<void>;
  getDefaultDownloadDir(): Promise<string | null>;
  setDefaultDownloadDir(path: string | null): Promise<void>;
  getTransferTuning(): Promise<TransferTuning>;
  setTransferTuning(tuning: TransferTuning): Promise<void>;
  getLastConnectionId(): Promise<string | null>;
  setLastConnectionId(id: string): Promise<void>;
}

export interface HostUpdates {
  /** Resolves to the available version, or null when already up to date. */
  checkForUpdate(): Promise<string | null>;
  /** Downloads and stages the update, reporting progress (0–100). */
  downloadUpdate(onProgress: (percent: number) => void): Promise<void>;
  /** Relaunches the app so the staged update takes effect. */
  relaunchApp(): Promise<void>;
  /** Downloads + stages + relaunches in one call (convenience for tests). */
  installAndRelaunch(): Promise<void>;
}

export interface Host {
  /** Injected into every S3Client. The Tauri host routes uploads through the
   * Rust fast path (src/tauri/http.ts); the Node host uses native fetch. */
  fetch: FetchFn;
  keychain: HostKeychain;
  stores: HostStores;
  files: HostFiles;
  dialogs: HostDialogs;
  shell: HostShell;
  tray: HostTray;
  settings: HostSettings;
  updates: HostUpdates;
  notify(title: string, body: string): Promise<void>;
  /** Native drag-and-drop. Emits the raw dropped paths; expanding folders into
   * files is LoploadServices' job (see expandDroppedPaths). */
  onFileDrop(cb: (paths: string[]) => void): () => void;
  /** Hover phases of a native file drag: fires with the cursor position (CSS
   * pixels, window-relative) while files are dragged over the window, and
   * null when the drag leaves it. A drop emits nothing here — the drop
   * handler (onFileDrop) owns resetting whatever state hovering built up, so
   * the hovered target can't be cleared out from under an in-flight drop. */
  onFileDragHover(cb: (position: { x: number; y: number } | null) => void): () => void;
  /** Starts mirroring logs to disk. No-op outside the app. */
  initLogSink(): Promise<void>;
}
