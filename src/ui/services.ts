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
} from "../lib/types";

/** Fields collected by the setup screen, before a Connection has an id. */
export type ConnectionDraft = Omit<Connection, "id" | "lastPrefix" | "createdAt"> &
  Credentials;

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

export interface BrowserService {
  list(connectionId: string, prefix: string): Promise<RemoteEntry[]>;
  createFolder(connectionId: string, prefix: string, name: string): Promise<void>;
  rename(connectionId: string, key: string, newName: string): Promise<void>;
  /** Moves a file or folder to a new full path — used for drag-and-drop moves
   * (renaming within the same parent goes through rename() above). */
  move(connectionId: string, key: string, toKey: string): Promise<void>;
  delete(connectionId: string, key: string): Promise<void>;
  /** A shareable link to the file, shown via "Copy link" in the context menu. */
  copyLink(connectionId: string, key: string): Promise<string>;
  /** Presigned URL for an image, or a streamable URL for a video; null if not previewable. */
  getThumbnailUrl(connectionId: string, key: string): Promise<string | null>;
  /** Recursively computes file count, total size, and last-modified time under a folder. */
  folderInfo(connectionId: string, key: string): Promise<FolderInfo>;
}

export interface EngineService {
  listTransfers(connectionId: string): Promise<Transfer[]>;
  /** Subscribes to engine events; returns an unsubscribe function. */
  subscribe(cb: (event: EngineEvent) => void): () => void;
  enqueueFiles(connectionId: string, prefix: string, files: PickedFile[]): Promise<void>;
  retry(transferId: string): Promise<void>;
  /** User has acknowledged a failed transfer; safe to stop showing it. */
  dismiss(transferId: string): Promise<void>;
}

export interface KeychainService {
  testConnection(draft: ConnectionDraft): Promise<TestConnectionResult>;
}

/** Everything the UI needs from the outside world, injected via context. */
export interface AppServices {
  connections: ConnectionsService;
  browser: BrowserService;
  engine: EngineService;
  keychain: KeychainService;
  /** Opens the native file picker; resolves with the files chosen (recursive for folders). */
  pickFiles(): Promise<PickedFile[]>;
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
