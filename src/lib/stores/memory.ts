import type {
  Connection,
  ConnectionStore,
  Transfer,
  TransferPart,
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
  private parts = new Map<string, TransferPart>();

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
    for (const key of this.parts.keys()) {
      if (key.startsWith(`${id}:`)) this.parts.delete(key);
    }
  }

  async saveParts(parts: TransferPart[]): Promise<void> {
    for (const p of parts) {
      this.parts.set(`${p.transferId}:${p.partNumber}`, { ...p });
    }
  }

  async listParts(transferId: string): Promise<TransferPart[]> {
    return Array.from(this.parts.values())
      .filter((p) => p.transferId === transferId)
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  async knownUploadIds(connectionId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const t of this.transfers.values()) {
      if (t.connectionId === connectionId && t.uploadId) ids.add(t.uploadId);
    }
    return ids;
  }
}