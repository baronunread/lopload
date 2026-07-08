// In-memory ConnectionStore/TransferStore implementations. Used by unit
// tests as a stand-in for the sqlite-backed production stores — same
// interfaces, no @tauri-apps/plugin-sql dependency.

import type {
  Connection,
  ConnectionStore,
  Transfer,
  TransferStore,
} from "../types";

export class MemoryConnectionStore implements ConnectionStore {
  private connections = new Map<string, Connection>();

  async list(): Promise<Connection[]> {
    return Array.from(this.connections.values());
  }

  async get(id: string): Promise<Connection | null> {
    return this.connections.get(id) ?? null;
  }

  async save(conn: Connection): Promise<void> {
    this.connections.set(conn.id, { ...conn });
  }

  async delete(id: string): Promise<void> {
    this.connections.delete(id);
  }

  async setLastPrefix(id: string, prefix: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn) conn.lastPrefix = prefix;
  }
}

export class MemoryTransferStore implements TransferStore {
  private transfers = new Map<string, Transfer>();

  async list(connectionId: string): Promise<Transfer[]> {
    return Array.from(this.transfers.values()).filter(
      (t) => t.connectionId === connectionId,
    );
  }

  async get(id: string): Promise<Transfer | null> {
    return this.transfers.get(id) ?? null;
  }

  async save(t: Transfer): Promise<void> {
    this.transfers.set(t.id, { ...t });
  }

  async delete(id: string): Promise<void> {
    this.transfers.delete(id);
  }
}
