export interface Connection {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  region?: string;
  lastPrefix: string;
  createdAt: number;
}

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

export type TransferState =
  | { kind: "queued" }
  | { kind: "sending"; percent: number; speedBytesPerSec?: number }
  | { kind: "checking" }
  | { kind: "uploaded" }
  | { kind: "downloaded" }
  | { kind: "failed"; errorClass: ErrorClass };

export interface Transfer {
  id: string;
  connectionId: string;
  key: string;
  localPath: string;
  size: number;
  partSize: number;
  uploadId?: string;
  folderId?: string;
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

export interface RemoteEntry {
  kind: "file" | "folder";
  name: string;
  key: string;
  size?: number;
  lastModified?: number;
}

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
  knownUploadIds(connectionId: string): Promise<Set<string>>;
}

export type EngineEvent =
  | { type: "transfer-updated"; transfer: Transfer }
  | { type: "batch-finished"; uploaded: number; downloaded: number; failed: number };

export interface PlainError {
  errorClass: ErrorClass;
  message: string;
}

export type TransferPreset = "slow" | "normal" | "fast" | "custom";

/** Knobs governing transfer throughput. `partSizeMiB` applies to uploads
 * (multipart part size) and downloads (ranged-GET chunk size) alike. Each
 * transfer's own `partSize` (src/lib/types.ts Transfer) is captured at
 * enqueue time from these knobs and persisted, so changing this setting
 * never affects a transfer already in flight or resumed later. */
export interface TransferTuning {
  preset: TransferPreset;
  /** Simultaneous transfers — gates TransferEngine's pump(). */
  concurrentFiles: number;
  /** Parallel UploadPart requests per file. */
  uploadPartsInFlight: number;
  /** Parallel ranged GETs per file. */
  downloadConnections: number;
  /** Upload part size and download range size, in MiB. */
  partSizeMiB: number;
}