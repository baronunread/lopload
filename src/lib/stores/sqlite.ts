// SQLite-backed ConnectionStore/TransferStore, wrapping @tauri-apps/plugin-sql.
// This is one of the few files under src/lib allowed to import a tauri
// plugin directly, since PLAN.md designates SQLite (not the OS keychain) as
// the store for connections and transfers.

import Database from "@tauri-apps/plugin-sql";

import type {
  Connection,
  ConnectionStore,
  ErrorClass,
  Transfer,
  TransferPart,
  TransferState,
  TransferStore,
} from "../types";

/** Schema per PLAN.md architecture decision #3. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    bucket TEXT NOT NULL,
    region TEXT,
    last_prefix TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transfers (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL,
    key TEXT NOT NULL,
    local_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    part_size INTEGER NOT NULL,
    upload_id TEXT,
    state TEXT NOT NULL,
    error_class TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `ALTER TABLE transfers ADD COLUMN folder_id TEXT`,
  `ALTER TABLE transfers ADD COLUMN folder_name TEXT`,
  `ALTER TABLE transfers ADD COLUMN direction TEXT NOT NULL DEFAULT 'upload'`,
  `CREATE TABLE IF NOT EXISTS transfer_parts (
    transfer_id TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    etag TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (transfer_id, part_number)
  )`,
];

let migrated: Promise<void> | null = null;

/** The selftest build gets its own database file: `bun run selftest` wipes
 * connection/transfer state between scenarios, and that must never touch the
 * connections the real app has saved. Vite inlines VITE_LOPLOAD_SELFTEST
 * statically, so normal builds keep the plain path with no branch. */
const DEFAULT_DB_PATH = import.meta.env.VITE_LOPLOAD_SELFTEST
  ? "sqlite:lopload-selftest.db"
  : "sqlite:lopload.db";

export async function loadDatabase(path = DEFAULT_DB_PATH): Promise<Database> {
  const db = await Database.load(path);
  if (!migrated) {
    migrated = (async () => {
      for (const stmt of MIGRATIONS) {
        try {
          await db.execute(stmt);
        } catch (err) {
          if (!/duplicate column name/i.test(String(err))) throw err;
        }
      }
    })();
  }
  await migrated;
  return db;
}

interface ConnectionRow {
  id: string;
  name: string;
  endpoint: string;
  bucket: string;
  region: string | null;
  last_prefix: string;
  created_at: number;
}

function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region ?? undefined,
    lastPrefix: row.last_prefix,
    createdAt: row.created_at,
  };
}

export class SqliteConnectionStore implements ConnectionStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<Connection[]> {
    const rows = await this.db.select<ConnectionRow[]>(
      "SELECT * FROM connections ORDER BY created_at ASC",
    );
    return rows.map(rowToConnection);
  }

  async get(id: string): Promise<Connection | null> {
    const rows = await this.db.select<ConnectionRow[]>(
      "SELECT * FROM connections WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToConnection(rows[0]) : null;
  }

  async save(conn: Connection): Promise<void> {
    await this.db.execute(
      `INSERT INTO connections (id, name, endpoint, bucket, region, last_prefix, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         endpoint = excluded.endpoint,
         bucket = excluded.bucket,
         region = excluded.region,
         last_prefix = excluded.last_prefix`,
      [
        conn.id,
        conn.name,
        conn.endpoint,
        conn.bucket,
        conn.region ?? null,
        conn.lastPrefix,
        conn.createdAt,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM connections WHERE id = $1", [id]);
  }

  async setLastPrefix(id: string, prefix: string): Promise<void> {
    await this.db.execute(
      "UPDATE connections SET last_prefix = $1 WHERE id = $2",
      [prefix, id],
    );
  }
}

interface TransferRow {
  id: string;
  connection_id: string;
  key: string;
  local_path: string;
  size: number;
  part_size: number;
  upload_id: string | null;
  state: string;
  error_class: string | null;
  folder_id: string | null;
  folder_name: string | null;
  direction: string;
  created_at: number;
  updated_at: number;
}

function rowToTransfer(row: TransferRow): Transfer {
  let state: TransferState;
  switch (row.state) {
    case "queued":
      state = { kind: "queued" };
      break;
    case "sending":
      state = { kind: "sending", percent: 0 };
      break;
    case "checking":
      state = { kind: "checking" };
      break;
    case "uploaded":
      state = { kind: "uploaded" };
      break;
    case "downloaded":
      state = { kind: "downloaded" };
      break;
    case "failed":
      state = {
        kind: "failed",
        errorClass: (row.error_class as ErrorClass | null) ?? "unknown",
      };
      break;
    default:
      state = { kind: "queued" };
  }
  return {
    id: row.id,
    connectionId: row.connection_id,
    key: row.key,
    localPath: row.local_path,
    size: row.size,
    partSize: row.part_size,
    uploadId: row.upload_id ?? undefined,
    folderId: row.folder_id ?? undefined,
    folderName: row.folder_name ?? undefined,
    direction: row.direction === "download" ? "download" : "upload",
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteTransferStore implements TransferStore {
  constructor(private readonly db: Database) {}

  async list(connectionId: string): Promise<Transfer[]> {
    const rows = await this.db.select<TransferRow[]>(
      "SELECT * FROM transfers WHERE connection_id = $1 ORDER BY created_at ASC",
      [connectionId],
    );
    return rows.map(rowToTransfer);
  }

  async get(id: string): Promise<Transfer | null> {
    const rows = await this.db.select<TransferRow[]>(
      "SELECT * FROM transfers WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToTransfer(rows[0]) : null;
  }

  async save(t: Transfer): Promise<void> {
    const errorClass = t.state.kind === "failed" ? t.state.errorClass : null;
    await this.db.execute(
      `INSERT INTO transfers (
         id, connection_id, key, local_path, size, part_size, upload_id,
         state, error_class, folder_id, folder_name, direction, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT(id) DO UPDATE SET
         upload_id = excluded.upload_id,
         state = excluded.state,
         error_class = excluded.error_class,
         updated_at = excluded.updated_at`,
      [
        t.id,
        t.connectionId,
        t.key,
        t.localPath,
        t.size,
        t.partSize,
        t.uploadId ?? null,
        t.state.kind,
        errorClass,
        t.folderId ?? null,
        t.folderName ?? null,
        t.direction,
        t.createdAt,
        t.updatedAt,
      ],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM transfer_parts WHERE transfer_id = $1", [id]);
    await this.db.execute("DELETE FROM transfers WHERE id = $1", [id]);
  }

  async saveParts(parts: TransferPart[]): Promise<void> {
    for (const p of parts) {
      await this.db.execute(
        `INSERT INTO transfer_parts (transfer_id, part_number, etag, size)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(transfer_id, part_number) DO UPDATE SET
           etag = excluded.etag,
           size = excluded.size`,
        [p.transferId, p.partNumber, p.etag, p.size],
      );
    }
  }

  async listParts(transferId: string): Promise<TransferPart[]> {
    const rows = await this.db.select<
      { transfer_id: string; part_number: number; etag: string; size: number }[]
    >(
      "SELECT * FROM transfer_parts WHERE transfer_id = $1 ORDER BY part_number ASC",
      [transferId],
    );
    return rows.map((r) => ({
      transferId: r.transfer_id,
      partNumber: r.part_number,
      etag: r.etag,
      size: r.size,
    }));
  }

  async knownUploadIds(connectionId: string): Promise<Set<string>> {
    const rows = await this.db.select<{ upload_id: string }[]>(
      `SELECT upload_id FROM transfers
       WHERE connection_id = $1 AND upload_id IS NOT NULL`,
      [connectionId],
    );
    return new Set(rows.map((r) => r.upload_id));
  }
}
