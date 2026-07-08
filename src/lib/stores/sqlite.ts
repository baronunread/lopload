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
    state TEXT NOT NULL,
    error_class TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `ALTER TABLE transfers ADD COLUMN folder_id TEXT`,
  `ALTER TABLE transfers ADD COLUMN folder_name TEXT`,
  `ALTER TABLE transfers ADD COLUMN direction TEXT NOT NULL DEFAULT 'upload'`,
];

let migrated: Promise<void> | null = null;

export async function loadDatabase(path = "sqlite:lopload.db"): Promise<Database> {
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
         id, connection_id, key, local_path, size,
         state, error_class, folder_id, folder_name, direction, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT(id) DO UPDATE SET
         state = excluded.state,
         error_class = excluded.error_class,
         updated_at = excluded.updated_at`,
      [
        t.id,
        t.connectionId,
        t.key,
        t.localPath,
        t.size,
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
    await this.db.execute("DELETE FROM transfers WHERE id = $1", [id]);
  }
}
