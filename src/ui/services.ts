// Dependency-injection seam between the UI (this directory) and the engine
// (src/lib, src/tauri) built by the other workstreams.
//
// The UI never imports src/lib or src/tauri directly — it only knows the
// shapes declared here (which reuse the shared contracts from
// src/lib/types.ts) and consumes them through React context. Tests provide
// fakes; a later integration agent provides the real implementation and
// wires it up in main.tsx/App.tsx.
import { createContext, useContext } from "react";
import type {
  Connection,
  Credentials,
  EngineEvent,
  RemoteEntry,
  Transfer,
  TransferTuning,
} from "../lib/types";

/** Fields collected by the setup screen, before a Connection has an id. */
export type ConnectionDraft = Omit<Connection, "id" | "lastPrefix" | "createdAt"> &
  Credentials;

/**
 * Thrown by services that need a connection's credentials when the keychain
 * has none to give — either the read threw (user hit Deny on the OS prompt,
 * or the signing identity changed and the ACL no longer matches) or it
 * resolved with no entry for this connection. Both cases are indistinguishable
 * from the caller's side and call for the same recovery: ask the user to
 * re-enter the access key and secret key. Distinct from the "credentials"
 * ErrorClass in src/lib/errors.ts, which classifies credentials the *server*
 * rejected — this is about credentials the *local keychain* couldn't produce
 * at all, before any request was made.
 */
export class CredentialsUnreadableError extends Error {
  readonly connectionId: string;

  constructor(connectionId: string) {
    super(`Credentials unreadable for connection: ${connectionId}`);
    this.name = "CredentialsUnreadableError";
    this.connectionId = connectionId;
  }
}

/** Result of a "Test connection" attempt — always plain language, never raw SDK text. */
export interface TestConnectionResult {
  ok: boolean;
  /** One plain sentence, success or failure. */
  message: string;
}

/** A file handed to the engine for upload, from either drag-drop or the picker. */
export interface PickedFile {
  path: string;
  name: string;
  size: number;
  /** Shared by every file dropped as part of the same folder, so the
   *  transfer widget can group them into one aggregated row. */
  folderId?: string;
  folderName?: string;
}

/** A remote file handed to the engine for download, with the local
 * destination path it should be written to. */
export interface DownloadTarget {
  key: string;
  localPath: string;
  size: number;
}

export interface ConnectionsService {
  list(): Promise<Connection[]>;
  /** Persists a new or edited connection. Credentials are saved separately via keychain. */
  save(conn: Connection, credentials: Credentials): Promise<void>;
  delete(id: string): Promise<void>;
  setLastPrefix(id: string, prefix: string): Promise<void>;
}

/** Computed-on-demand stats for a folder's info dialog — S3 "folders" are
 * virtual prefixes with no metadata of their own, so this walks the folder's
 * contents recursively rather than being available from the listing. */
export interface FolderInfo {
  files: number;
  totalSize: number;
  lastModified: number | null;
}

/**
 * How far along a move's copy phase is. Weighted both ways on purpose: bytes
 * drive the percentage, because a folder of a few huge files would otherwise
 * sit at 0% and jump to 100% as each object lands; items drive the
 * "N of M items" label, because bytes read as nothing on a folder of empty
 * folder markers.
 */
export interface CopyProgress {
  copiedBytes: number;
  totalBytes: number;
  copiedItems: number;
  totalItems: number;
}

/** Progress of an in-flight S3 move (rename or drag-to-move). Emitted by
 * BrowserService.subscribeMoves and used by TransferWidget to show status.
 * `kind` distinguishes the four operations that all reuse this same tracking
 * machinery (see appServices.ts's runTracked) so the widget can label and
 * icon each row appropriately: a plain rename/drag-move, a move to Trash, a
 * restore out of Trash, or a permanent delete (Delete now / Empty trash). */
export interface MoveProgress extends CopyProgress {
  moveId: string;
  connectionId: string;
  fromKey: string;
  toKey: string;
  kind: "move" | "trash" | "restore" | "purge";
  status: "moving" | "completed" | "failed";
  errorMessage?: string;
}

export interface BrowserService {
  list(connectionId: string, prefix: string): Promise<RemoteEntry[]>;
  createFolder(connectionId: string, prefix: string, name: string): Promise<void>;
  rename(
    connectionId: string,
    key: string,
    newName: string,
    onProgress?: (progress: CopyProgress) => void,
  ): Promise<void>;
  /** Moves a file or folder to a new full path — used for drag-and-drop moves
   * (renaming within the same parent goes through rename() above).
   * `onProgress`, if given, is called as each object — or each part of a large
   * object — finishes copying, not just at the end. */
  move(
    connectionId: string,
    key: string,
    toKey: string,
    onProgress?: (progress: CopyProgress) => void,
  ): Promise<void>;
  /** Moves a file or folder into the Trash rather than deleting it outright —
   * see TrashService for restoring it or removing it for good. */
  delete(connectionId: string, key: string): Promise<void>;
  /** A shareable, presigned link to the file, valid for `expiresInSeconds`
   * (capped at 7 days — SigV4's hard maximum), shown via "Copy link…" in the
   * context menu. */
  copyLink(connectionId: string, key: string, expiresInSeconds: number): Promise<string>;
  /** Presigned URL for an image, or a streamable URL for a video; null if not previewable. */
  getThumbnailUrl(connectionId: string, key: string): Promise<string | null>;
  /** Recursively computes file count, total size, and last-modified time under a folder. */
  folderInfo(connectionId: string, key: string): Promise<FolderInfo>;
  /** Every file (not folder markers) under a folder prefix, with size — used
   * to enqueue a recursive folder download. */
  listFilesRecursive(connectionId: string, prefix: string): Promise<{ key: string; size: number }[]>;
  /** Subscribe to move progress events. Returns an unsubscribe function. */
  subscribeMoves(cb: (event: MoveProgress) => void): () => void;
}

/** One row in the Trash view: a file, or a whole folder trashed as a single
 * action (restoring/removing it for good acts on everything under it). */
export interface TrashItem {
  /** Stable id for this row, unique within a connection's trash. */
  id: string;
  /** Full path the item lived at before it was trashed — a folder's own
   * path ends in "/", same convention as RemoteEntry. */
  originalKey: string;
  kind: "file" | "folder";
  deletedAt: number;
  /** When the silent purge sweep removes this for good. */
  purgeAt: number;
  size: number;
}

export interface TrashService {
  list(connectionId: string): Promise<TrashItem[]>;
  /** Moves an item back to its original path. Throws if something already
   * exists there — the trashed copy is left untouched either way.
   * `onProgress`, if given, is called directly (in addition to the global
   * move stream) so a caller like TrashDialog can show "N of M items" on the
   * specific row it's restoring without listening to every in-flight move. */
  restore(
    connectionId: string,
    item: TrashItem,
    onProgress?: (progress: CopyProgress) => void,
  ): Promise<void>;
  /** Removes a single trashed item for good. */
  deleteNow(
    connectionId: string,
    item: TrashItem,
    onProgress?: (progress: CopyProgress) => void,
  ): Promise<void>;
  /** Removes everything in this connection's Trash for good. */
  emptyTrash(connectionId: string, onProgress?: (progress: CopyProgress) => void): Promise<void>;
}

export interface EngineService {
  listTransfers(connectionId: string): Promise<Transfer[]>;
  /** Subscribes to engine events; returns an unsubscribe function. */
  subscribe(cb: (event: EngineEvent) => void): () => void;
  enqueueFiles(connectionId: string, prefix: string, files: PickedFile[]): Promise<void>;
  /** Enqueues one or more remote files for download, each to its own local destination. */
  enqueueDownloads(connectionId: string, targets: DownloadTarget[]): Promise<void>;
  /** User has acknowledged a failed transfer; safe to stop showing it. */
  dismiss(transferId: string): Promise<void>;
  /** Cancels a queued or in-flight transfer; aborts any in-flight request. */
  cancel(transferId: string): Promise<void>;
  /** Aborts any leftover in-progress uploads for failed transfers (crash
   * before completion), and clears their persisted state so a future retry
   * starts fresh instead of trying to resume a dead one. Manual, from
   * Settings — never runs on its own. */
  abortStaleUploads(connectionId: string): Promise<{ aborted: number; errors: number }>;
}

export interface KeychainService {
  testConnection(draft: ConnectionDraft): Promise<TestConnectionResult>;
}

/** Auto-update checking + install. A no-op outside the Tauri runtime (e.g.
 * `bun run dev` in a browser tab), so the demo backend never touches it. */
export interface UpdatesService {
  /** Checks for a new release now. Resolves with its version string if one
   * is available, otherwise null. */
  checkForUpdate(): Promise<string | null>;
  /** Downloads and stages the update found by the last checkForUpdate() call
   * that found one, reporting progress (0–100) via onProgress. Does not
   * relaunch; call relaunchApp() once the user chooses to restart. */
  downloadUpdate(onProgress: (percent: number) => void): Promise<void>;
  /** Relaunches the app so the freshly-staged update takes effect. */
  relaunchApp(): Promise<void>;
  /** Whether periodic auto-update checks are enabled (default true). */
  isAutoUpdateEnabled(): Promise<boolean>;
  /** Toggle periodic auto-update checks on/off. Manual check always works. */
  setAutoUpdateEnabled(enabled: boolean): Promise<void>;
}

/** App preferences persisted via @tauri-apps/plugin-store. */
export interface SettingsService {
  getDefaultDownloadDir(): Promise<string | null>;
  setDefaultDownloadDir(path: string | null): Promise<void>;
  getTransferTuning(): Promise<TransferTuning>;
  setTransferTuning(tuning: TransferTuning): Promise<void>;
  getLastConnectionId(): Promise<string | null>;
  setLastConnectionId(id: string): Promise<void>;
}

/** Everything the UI needs from the outside world, injected via context. */
export interface AppServices {
  connections: ConnectionsService;
  browser: BrowserService;
  trash: TrashService;
  engine: EngineService;
  keychain: KeychainService;
  updates: UpdatesService;
  settings: SettingsService;
  /** Opens the native file picker; resolves with the files chosen (recursive for folders). */
  pickFiles(): Promise<PickedFile[]>;
  /** Native "Save as" dialog for downloading a single file; suggests
   * `defaultName`. Resolves with the chosen path, or null if cancelled. */
  pickSaveDestination(defaultName: string): Promise<string | null>;
  /** Native folder picker for downloading a folder's contents. Resolves
   * with the chosen directory, or null if cancelled. */
  pickDownloadDirectory(): Promise<string | null>;
  /** Downloads a file to a temporary location and opens it with the
   * system's default app for its type once the download is verified. */
  openFile(connectionId: string, key: string, name: string): Promise<void>;
  /** Reveals the given file in the native file manager (Finder / Explorer). */
  revealInFinder(path: string): Promise<void>;
  /** Subscribes to OS-level drag-and-drop of files onto the window. Folders
   * are expanded recursively; each resulting file carries its size and a
   * name that preserves the relative path under any dropped folder.
   * `onError`, if provided, is called with a plain-language-adjacent message
   * when a dropped folder can't be read (e.g. an unreadable subdirectory) —
   * without it such failures were only visible in the console/OS notifications. */
  onFileDrop(cb: (files: PickedFile[]) => void, onError?: (message: string) => void): () => void;
  /** Updates the dock/taskbar badge to reflect the current failed-transfer count. */
  setBadgeCount(count: number): void;
  /** Fires a native OS notification. */
  notify(title: string, body: string): void;
}

const ServicesContext = createContext<AppServices | null>(null);

export const ServicesProvider = ServicesContext.Provider;

/** Reads the injected AppServices. Throws if used outside a ServicesProvider. */
export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error(
      "useServices() called without a ServicesProvider — wrap the app in <ServicesProvider value={...}>",
    );
  }
  return services;
}
