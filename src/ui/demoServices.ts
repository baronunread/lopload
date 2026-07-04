// In-memory AppServices implementation used only so `bun run dev` renders
// something before the real engine (src/lib, src/tauri) exists.
//
// INTEGRATION AGENT: replace this with the real implementation wired to
// src/lib/engine.ts, src/lib/stores/*, src/tauri/* — swap the import in
// main.tsx. Nothing else in src/ui/ should need to change; that's the
// point of the AppServices seam in services.ts.
import type { Connection, EngineEvent, RemoteEntry, Transfer } from "../lib/types";
import type { AppServices } from "./services";

export function createDemoServices(): AppServices {
  const connections = new Map<string, Connection>();
  const listeners = new Set<(event: EngineEvent) => void>();

  return {
    connections: {
      async list() {
        return Array.from(connections.values());
      },
      async save(conn) {
        connections.set(conn.id, conn);
      },
      async delete(id) {
        connections.delete(id);
      },
      async setLastPrefix(id, prefix) {
        const conn = connections.get(id);
        if (conn) connections.set(id, { ...conn, lastPrefix: prefix });
      },
    },
    browser: {
      async list(): Promise<RemoteEntry[]> {
        return [];
      },
      async createFolder() {},
      async rename() {},
      async delete() {},
      async copyLink() {
        return "";
      },
      async getThumbnailUrl() {
        return null;
      },
    },
    engine: {
      async listTransfers(): Promise<Transfer[]> {
        return [];
      },
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async enqueueFiles() {},
      async retry() {},
      async dismiss() {},
    },
    keychain: {
      async testConnection() {
        return { ok: false, message: "Storage isn't wired up in this preview build yet." };
      },
    },
    async pickFiles() {
      return [];
    },
    onFileDrop() {
      return () => {};
    },
    setBadgeCount() {},
    notify() {},
  };
}
