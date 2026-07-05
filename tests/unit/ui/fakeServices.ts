// Shared fake AppServices for UI tests — implements the seam from
// src/ui/services.ts entirely in memory, with no dependency on src/lib or
// src/tauri (which may not exist yet while this workstream is in progress).
import type { Connection, EngineEvent, RemoteEntry, Transfer } from "../../../src/lib/types";
import type {
  AppServices,
  ConnectionDraft,
  FolderInfo,
  PickedFile,
} from "../../../src/ui/services";

export interface FakeServicesOptions {
  connections?: Connection[];
  /** Keyed by `${connectionId}::${prefix}` — the exact listing for that folder. */
  entriesByPrefix?: Record<string, RemoteEntry[]>;
  transfersByConnection?: Record<string, Transfer[]>;
  testConnectionResult?: { ok: boolean; message: string };
  pickFilesResult?: PickedFile[];
  folderInfoResult?: FolderInfo;
}

export interface FakeServices extends AppServices {
  emit(event: EngineEvent): void;
  retryCalls: string[];
  dismissCalls: string[];
  setLastPrefixCalls: Array<{ id: string; prefix: string }>;
  badgeCounts: number[];
  notifications: Array<{ title: string; body: string }>;
  savedConnections: Connection[];
  testConnectionCalls: ConnectionDraft[];
  moveCalls: Array<{ connectionId: string; key: string; toKey: string }>;
  deleteCalls: string[];
  folderInfoCalls: Array<{ connectionId: string; key: string }>;
  /** Simulates the real onFileDrop's onError firing (e.g. an unreadable
   * dropped folder), for tests of the resulting error toast. */
  triggerFileDropError(message: string): void;
}

export function createFakeServices(options: FakeServicesOptions = {}): FakeServices {
  const connections = new Map<string, Connection>(
    (options.connections ?? []).map((c) => [c.id, c]),
  );
  const listeners = new Set<(event: EngineEvent) => void>();
  const retryCalls: string[] = [];
  const dismissCalls: string[] = [];
  const setLastPrefixCalls: Array<{ id: string; prefix: string }> = [];
  const badgeCounts: number[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const savedConnections: Connection[] = [];
  const testConnectionCalls: ConnectionDraft[] = [];
  const moveCalls: Array<{ connectionId: string; key: string; toKey: string }> = [];
  const deleteCalls: string[] = [];
  const folderInfoCalls: Array<{ connectionId: string; key: string }> = [];
  let fileDropErrorHandler: ((message: string) => void) | null = null;

  const services: FakeServices = {
    connections: {
      async list() {
        return Array.from(connections.values());
      },
      async save(conn) {
        connections.set(conn.id, conn);
        savedConnections.push(conn);
      },
      async delete(id) {
        connections.delete(id);
      },
      async setLastPrefix(id, prefix) {
        setLastPrefixCalls.push({ id, prefix });
        const conn = connections.get(id);
        if (conn) connections.set(id, { ...conn, lastPrefix: prefix });
      },
    },
    browser: {
      async list(connectionId, prefix) {
        return options.entriesByPrefix?.[`${connectionId}::${prefix}`] ?? [];
      },
      async createFolder() {},
      async rename() {},
      async move(connectionId, key, toKey) {
        moveCalls.push({ connectionId, key, toKey });
      },
      async delete(_connectionId, key) {
        deleteCalls.push(key);
      },
      async copyLink(_connectionId, key) {
        return `https://example.test/${key}`;
      },
      async getThumbnailUrl() {
        return null;
      },
      async folderInfo(connectionId, key) {
        folderInfoCalls.push({ connectionId, key });
        return options.folderInfoResult ?? { files: 0, totalSize: 0, lastModified: null };
      },
    },
    engine: {
      async listTransfers(connectionId) {
        return options.transfersByConnection?.[connectionId] ?? [];
      },
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async enqueueFiles() {},
      async retry(transferId) {
        retryCalls.push(transferId);
      },
      async dismiss(transferId) {
        dismissCalls.push(transferId);
      },
    },
    keychain: {
      async testConnection(draft) {
        testConnectionCalls.push(draft);
        return options.testConnectionResult ?? { ok: true, message: "Connection works." };
      },
    },
    async pickFiles() {
      return options.pickFilesResult ?? [];
    },
    onFileDrop(_cb, onError) {
      fileDropErrorHandler = onError ?? null;
      return () => {
        fileDropErrorHandler = null;
      };
    },
    setBadgeCount(count) {
      badgeCounts.push(count);
    },
    notify(title, body) {
      notifications.push({ title, body });
    },
    emit(event) {
      for (const cb of listeners) cb(event);
    },
    triggerFileDropError(message) {
      fileDropErrorHandler?.(message);
    },
    retryCalls,
    dismissCalls,
    setLastPrefixCalls,
    badgeCounts,
    notifications,
    savedConnections,
    testConnectionCalls,
    moveCalls,
    deleteCalls,
    folderInfoCalls,
  };

  return services;
}
