// Shared contracts between engine (lib/), Rust bridge (tauri/), and UI (ui/).
// Agents: extend freely, but do not rename or remove existing members.

/** One saved storage connection ("bucket" never appears in UI copy). */
export interface Connection {
  id: string;
  /** Short display name the user assigned, e.g. "Videos". */
  name: string;
  endpoint: string;
  bucket: string;
  region?: string;
  /** Last folder browsed in this connection, "" = root. */
  lastPrefix: string;
  createdAt: number;
}

/** Secrets live only in the OS keychain, never alongside Connection. */
export interface Credentials {
  accessKey: string;
  secretKey: string;
}

export type ErrorClass =
  | "offline"
  | "credentials"
  | "storage-full"
  | "connection-dropped"
  | "verification"
  | "not-found"
  | "unknown";

/** Exact status vocabulary from the spec — the UI renders these 1:1.
 * "uploaded"/"downloaded" are the two terminal-success states, one per
 * transfer direction; everything else is shared between both directions. */
export type TransferState =
  | { kind: "queued" }
  | { kind: "sending"; percent: number }
  | { kind: "checking" }
  | { kind: "uploaded" }
  | { kind: "downloaded" }
  | { kind: "failed"; errorClass: ErrorClass };

export interface Transfer {
  id: string;
  connectionId: string;
  /** Remote key, e.g. "videos/clip.mp4" (UI shows it as folder path + name). */
  key: string;
  /** Local file path: source for an upload, destination for a download. */
  localPath: string;
  size: number;
  partSize: number;
  /** Set once a multipart upload session exists; drives resume + orphan matching. */
  uploadId?: string;
  /** Shared by every transfer that came from the same dropped/picked folder,
   *  so the UI can render them as one aggregated row instead of one per file. */
  folderId?: string;
  /** Display name for the aggregated folder row. Only set alongside `folderId`. */
  folderName?: string;
  direction: "upload" | "download";
  state: TransferState;
  createdAt: number;
  updatedAt: number;
}

export interface TransferPart {
  transferId: string;
  partNumber: number;
  etag: string;
  size: number;
}

/** A remote listing entry; "folder" is a synthesized common prefix. */
export interface RemoteEntry {
  kind: "file" | "folder";
  name: string;
  key: string;
  size?: number;
  lastModified?: number;
}

// ---- persistence interfaces (sqlite impl in app, in-memory impl in tests) ----

export interface ConnectionStore {
  list(): Promise<Connection[]>;
  get(id: string): Promise<Connection | null>;
  save(conn: Connection): Promise<void>;
  delete(id: string): Promise<void>;
  setLastPrefix(id: string, prefix: string): Promise<void>;
}

export interface TransferStore {
  list(connectionId: string): Promise<Transfer[]>;
  get(id: string): Promise<Transfer | null>;
  save(t: Transfer): Promise<void>;
  delete(id: string): Promise<void>;
  saveParts(parts: TransferPart[]): Promise<void>;
  listParts(transferId: string): Promise<TransferPart[]>;
  /** upload_ids of every locally-tracked multipart session (orphan sweep). */
  knownUploadIds(connectionId: string): Promise<Set<string>>;
}

// ---- engine events the UI subscribes to ----

export type EngineEvent =
  | { type: "transfer-updated"; transfer: Transfer }
  | { type: "batch-finished"; uploaded: number; downloaded: number; failed: number };

export interface PlainError {
  errorClass: ErrorClass;
  /** One plain-language sentence, no SDK/XML text, no storage jargon. */
  message: string;
}
