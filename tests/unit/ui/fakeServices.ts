import type {
  Connection,
  EngineEvent,
  RemoteEntry,
  Transfer,
  TransferTuning,
} from "../../../src/lib/types";
import { DEFAULT_TUNING } from "../../../src/lib/tuning";
import { CredentialsUnreadableError } from "../../../src/ui/services";
import type {
  AppServices,
  ConnectionDraft,
  DownloadTarget,
  FolderInfo,
  MoveProgress,
  PickedFile,
  TrashItem,
} from "../../../src/ui/services";

export interface FakeServicesOptions {
  connections?: Connection[];
  entriesByPrefix?: Record<string, RemoteEntry[]>;
  transfersByConnection?: Record<string, Transfer[]>;
  testConnectionResult?: { ok: boolean; message: string };
  pickFilesResult?: PickedFile[];
  folderInfoResult?: FolderInfo;
  filesRecursiveByPrefix?: Record<string, { key: string; size: number }[]>;
  saveDestinationResult?: string | null;
  downloadDirectoryResult?: string | null;
  trashItems?: TrashItem[];
  credentialsUnreadableFor?: Set<string>;
  updateVersion?: string | null;
  /** Progress values (0–100) the fake downloadUpdate emits before resolving.
   * Defaults to [100], one step straight to done. */
  updateDownloadSteps?: number[];
  transferTuning?: TransferTuning;
}

export interface FakeServices extends AppServices {
  emit(event: EngineEvent): void;
  /** Push a move-progress event to whatever's subscribed via subscribeMoves. */
  emitMove(event: MoveProgress): void;
  dismissCalls: string[];
  cancelCalls: string[];
  enqueueDownloadsCalls: Array<{ connectionId: string; targets: DownloadTarget[] }>;
  openFileCalls: Array<{ connectionId: string; key: string; name: string }>;
  setLastPrefixCalls: Array<{ id: string; prefix: string }>;
  badgeCounts: number[];
  notifications: Array<{ title: string; body: string }>;
  savedConnections: Connection[];
  testConnectionCalls: ConnectionDraft[];
  moveCalls: Array<{ connectionId: string; key: string; toKey: string }>;
  deleteCalls: string[];
  folderInfoCalls: Array<{ connectionId: string; key: string }>;
  restoreCalls: TrashItem[];
  deleteNowCalls: TrashItem[];
  emptyTrashCalls: string[];
  triggerFileDropError(message: string): void;
  checkForUpdateCalls: number[];
  downloadUpdateCalls: number[];
  relaunchAppCalls: number[];
  setTransferTuningCalls: TransferTuning[];
  abortStaleUploadsCalls: string[];
}

export function createFakeServices(options: FakeServicesOptions = {}): FakeServices {
  const connections = new Map<string, Connection>(
    (options.connections ?? []).map((c) => [c.id, c]),
  );
  const listeners = new Set<(event: EngineEvent) => void>();
  const dismissCalls: string[] = [];
  const cancelCalls: string[] = [];
  const enqueueDownloadsCalls: Array<{ connectionId: string; targets: DownloadTarget[] }> = [];
  const openFileCalls: Array<{ connectionId: string; key: string; name: string }> = [];
  const setLastPrefixCalls: Array<{ id: string; prefix: string }> = [];
  const badgeCounts: number[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const savedConnections: Connection[] = [];
  const testConnectionCalls: ConnectionDraft[] = [];
  const moveCalls: Array<{ connectionId: string; key: string; toKey: string }> = [];
  const moveSubscribers = new Set<(event: MoveProgress) => void>();
  const deleteCalls: string[] = [];
  const folderInfoCalls: Array<{ connectionId: string; key: string }> = [];
  const restoreCalls: TrashItem[] = [];
  const deleteNowCalls: TrashItem[] = [];
  const emptyTrashCalls: string[] = [];
  const credentialsUnreadableFor = new Set(options.credentialsUnreadableFor ?? []);
  let fileDropErrorHandler: ((message: string) => void) | null = null;
  const checkForUpdateCalls: number[] = [];
  const downloadUpdateCalls: number[] = [];
  const relaunchAppCalls: number[] = [];
  const setTransferTuningCalls: TransferTuning[] = [];
  const abortStaleUploadsCalls: string[] = [];
  let transferTuning: TransferTuning = options.transferTuning ?? DEFAULT_TUNING;
  let lastConnectionId: string | null = null;

  const services: FakeServices = {
    connections: {
      async list() {
        return Array.from(connections.values());
      },
      async save(conn) {
        connections.set(conn.id, conn);
        savedConnections.push(conn);
        credentialsUnreadableFor.delete(conn.id);
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
        if (credentialsUnreadableFor.has(connectionId)) {
          throw new CredentialsUnreadableError(connectionId);
        }
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
      async copyLink(_connectionId, key, expiresInSeconds) {
        return `https://example.test/${key}?expires=${expiresInSeconds}`;
      },
      async getThumbnailUrl() {
        return null;
      },
      async folderInfo(connectionId, key) {
        folderInfoCalls.push({ connectionId, key });
        return options.folderInfoResult ?? { files: 0, totalSize: 0, lastModified: null };
      },
      async listFilesRecursive(connectionId, prefix) {
        return options.filesRecursiveByPrefix?.[`${connectionId}::${prefix}`] ?? [];
      },
      subscribeMoves(cb: (event: MoveProgress) => void): () => void {
        moveSubscribers.add(cb);
        return () => moveSubscribers.delete(cb);
      },
    },
    trash: {
      async list() {
        return options.trashItems ?? [];
      },
      async restore(_connectionId, item) {
        restoreCalls.push(item);
      },
      async deleteNow(_connectionId, item) {
        deleteNowCalls.push(item);
      },
      async emptyTrash(connectionId) {
        emptyTrashCalls.push(connectionId);
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
      async enqueueDownloads(connectionId, targets) {
        enqueueDownloadsCalls.push({ connectionId, targets });
      },
      async dismiss(transferId) {
        dismissCalls.push(transferId);
      },
      async cancel(transferId) {
        cancelCalls.push(transferId);
      },
      async abortStaleUploads(connectionId) {
        abortStaleUploadsCalls.push(connectionId);
        return { aborted: 0, errors: 0 };
      },
    },
    keychain: {
      async testConnection(draft) {
        testConnectionCalls.push(draft);
        return options.testConnectionResult ?? { ok: true, message: "Connection works." };
      },
    },
    updates: {
      async checkForUpdate() {
        checkForUpdateCalls.push(Date.now());
        return options.updateVersion ?? null;
      },
      async downloadUpdate(onProgress: (percent: number) => void) {
        downloadUpdateCalls.push(Date.now());
        for (const step of options.updateDownloadSteps ?? [100]) {
          onProgress(step);
        }
      },
      async relaunchApp() {
        relaunchAppCalls.push(Date.now());
      },
      async isAutoUpdateEnabled() {
        return true;
      },
      async setAutoUpdateEnabled() {},
    },
    settings: {
      async getDefaultDownloadDir() {
        return null;
      },
      async setDefaultDownloadDir() {},
      async getTransferTuning() {
        return transferTuning;
      },
      async setTransferTuning(tuning) {
        transferTuning = tuning;
        setTransferTuningCalls.push(tuning);
      },
      async getLastConnectionId() {
        return lastConnectionId;
      },
      async setLastConnectionId(id) {
        lastConnectionId = id;
      },
    },
    async pickFiles() {
      return options.pickFilesResult ?? [];
    },
    async pickSaveDestination() {
      return options.saveDestinationResult ?? null;
    },
    async pickDownloadDirectory() {
      return options.downloadDirectoryResult ?? null;
    },
    async openFile(connectionId, key, name) {
      openFileCalls.push({ connectionId, key, name });
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
    emitMove(event) {
      for (const cb of moveSubscribers) cb(event);
    },
    triggerFileDropError(message) {
      fileDropErrorHandler?.(message);
    },
    dismissCalls,
    cancelCalls,
    enqueueDownloadsCalls,
    openFileCalls,
    setLastPrefixCalls,
    badgeCounts,
    notifications,
    savedConnections,
    testConnectionCalls,
    moveCalls,
    deleteCalls,
    folderInfoCalls,
    restoreCalls,
    deleteNowCalls,
    emptyTrashCalls,
    checkForUpdateCalls,
    downloadUpdateCalls,
    relaunchAppCalls,
    setTransferTuningCalls,
    abortStaleUploadsCalls,
  };

  return services;
}
