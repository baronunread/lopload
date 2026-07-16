// The app's wiring layer: it implements AppServices (src/ui/services.ts) on top
// of the framework-free engine (src/lib). There is exactly one implementation —
// this one. (It used to be called real.ts, back when a hand-written fake sat
// beside it. The fake is gone, and with it the only reason the word "real"
// meant anything here.)
//
// It reaches the outside world only through a Host (src/services/host.ts) — the
// narrow platform boundary — which is what lets this file, the whole wiring
// layer, run unchanged in `bun test` against a Node host and inside the real
// webview against the Tauri host. It imports no @tauri-apps/*.
//
// Kept deliberately "boring": every UI-facing method is a thin adapter that
// resolves a per-connection S3Client/TransferEngine (lazily, cached) and
// calls straight into src/lib. Anything with real logic (folder-drop
// expansion) is factored out into a pure, separately-unit-tested module.
import type { S3Client } from "@aws-sdk/client-s3";

import type { Host } from "./host";
import type {
  Connection,
  ConnectionStore,
  Credentials,
  EngineEvent,
  RemoteEntry,
  Transfer,
  TransferStore,
  TransferTuning,
} from "../lib/types";
import { createLogger } from "../lib/logger";
import { DEFAULT_TUNING } from "../lib/tuning";
import { TransferEngine, type EnqueueFile } from "../lib/engine";
import {
  copyLink as s3CopyLink,
  createFolder as s3CreateFolder,
  createS3Client,
  deleteTrashItem as s3DeleteTrashItem,
  emptyTrash as s3EmptyTrash,
  folderStats,
  listEntries,
  listFilesUnder,
  listTrash as s3ListTrash,
  moveFileToTrash as s3MoveFileToTrash,
  moveFolderToTrash as s3MoveFolderToTrash,
  renameFile as s3RenameFile,
  renameFolder as s3RenameFolder,
  restoreFileFromTrash as s3RestoreFileFromTrash,
  restoreFolderFromTrash as s3RestoreFolderFromTrash,
  testConnection as s3TestConnection,
} from "../lib/s3/client";
import { sweepTrash } from "../lib/s3/trashSweep";
import { abortStaleUploads } from "../lib/s3/orphanSweep";
import { deriveTrayUploadTargets } from "./trayState";

import { isImageName } from "../ui/format";
import { invalidateConnection as invalidateListingCacheForConnection } from "../ui/listingCache";
import { CredentialsUnreadableError } from "../ui/services";
import type {
  AppServices,
  ConnectionDraft,
  CopyProgress,
  DownloadTarget,
  FolderInfo,
  MoveProgress,
  PickedFile,
  TestConnectionResult,
  TrashItem,
} from "../ui/services";
import { expandDroppedPaths, type DropDirEntry } from "./dragDropExpand";

const log = createLogger("services");

const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Thumbnails are re-requested each time they're shown, so this only needs
 * to outlive a single render — no reason to hand out a long-lived link. */
const THUMBNAIL_URL_EXPIRY_SECONDS = 60 * 60;

/** Detects whether a remote key names a "folder" (trailing slash), per the
 * convention listEntries() uses when synthesizing folder entries. */
function isFolderKey(key: string): boolean {
  return key.endsWith("/");
}

function parentOf(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? "" : trimmed.slice(0, idx + 1);
}

function renameKey(fromKey: string, newName: string): string {
  const folder = isFolderKey(fromKey);
  const parent = parentOf(fromKey);
  return folder ? `${parent}${newName}/` : `${parent}${newName}`;
}

class LoploadServices implements AppServices {
  constructor(private readonly host: Host) {}

  /** Cached per-connection S3 clients, invalidated on credential/connection changes. */
  private clients = new Map<string, S3Client>();
  /** Cached per-connection engines, created lazily on first use (a "switch to"). */
  private engines = new Map<string, TransferEngine>();
  /** In-flight/completed engine construction promises, memoized per
   * connection so concurrent callers (e.g. listTransfers + enqueue at
   * startup) await the same construction instead of each building — and
   * each resuming pending transfers on — their own TransferEngine instance. */
  private enginePromises = new Map<string, Promise<TransferEngine>>();

  private engineSubscribers = new Set<(event: EngineEvent) => void>();
  /** Latest known state of every transfer across all engines, for tray progress. */
  private transferSnapshots = new Map<string, Transfer>();

  private moveSubscribers = new Set<(event: MoveProgress) => void>();
  private activeMoves = new Map<string, MoveProgress>();

  private trashSweepStarted = false;
  private trashSweepTimer: ReturnType<typeof setInterval> | null = null;
  private trayUploadListening = false;
  private trayUploadUnsubscribe: (() => void) | null = null;

  /** In-memory copy of the persisted transfer tuning, lazily loaded on
   * first engine use and shared by every connection's engine via a live
   * `() => this.tuning` closure — so changing it in Settings takes effect
   * immediately, without recreating any cached engine. */
  private tuning: TransferTuning = DEFAULT_TUNING;
  private tuningLoaded = false;
  private tuningLoadPromise: Promise<void> | null = null;

  private async ensureTuningLoaded(): Promise<void> {
    if (this.tuningLoaded) return;
    if (!this.tuningLoadPromise) {
      this.tuningLoadPromise = this.host.settings.getTransferTuning().then((t) => {
        this.tuning = t;
        this.tuningLoaded = true;
      });
    }
    await this.tuningLoadPromise;
  }

  private getConnectionStore(): Promise<ConnectionStore> {
    return this.host.stores.connections();
  }

  private getTransferStore(): Promise<TransferStore> {
    return this.host.stores.transfers();
  }

  private async getClient(connectionId: string): Promise<{ client: S3Client; conn: Connection }> {
    const store = await this.getConnectionStore();
    const conn = await store.get(connectionId);
    if (!conn) throw new Error(`Unknown connection: ${connectionId}`);
    let client = this.clients.get(connectionId);
    if (!client) {
      const credentials = await this.host.keychain.get(connectionId);
      if (!credentials) throw new CredentialsUnreadableError(connectionId);
      client = createS3Client(conn, credentials, this.host.fetch);
      this.clients.set(connectionId, client);
    }
    return { client, conn };
  }

  private invalidateConnection(connectionId: string): void {
    this.clients.delete(connectionId);
    this.engines.delete(connectionId);
    this.enginePromises.delete(connectionId);
    // A saved/deleted connection's credentials, endpoint, or bucket may have
    // changed — any cached listing/folder-stats for it now potentially
    // describe a different bucket, so they can't be trusted going forward.
    invalidateListingCacheForConnection(connectionId);
  }

  private async getEngine(connectionId: string): Promise<TransferEngine> {
    let enginePromise = this.enginePromises.get(connectionId);
    if (!enginePromise) {
      enginePromise = this.buildEngine(connectionId).catch((err) => {
        // Construction failed — clear the memoized promise so a later call
        // can retry instead of being stuck replaying the same rejection.
        this.enginePromises.delete(connectionId);
        throw err;
      });
      this.enginePromises.set(connectionId, enginePromise);
    }
    return enginePromise;
  }

  private async buildEngine(connectionId: string): Promise<TransferEngine> {
    await this.ensureTuningLoaded();
    const { client, conn } = await this.getClient(connectionId);
    const store = await this.getTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: conn.bucket,
      connectionId,
      reader: this.host.files.reader,
      writer: this.host.files.writer,
      store,
      tuning: () => this.tuning,
    });
    engine.subscribe((event) => this.onEngineEvent(connectionId, event));
    this.engines.set(connectionId, engine);
    await engine.resumePending();
    return engine;
  }

  private onEngineEvent(_connectionId: string, event: EngineEvent): void {
    if (event.type === "transfer-updated") {
      this.transferSnapshots.set(event.transfer.id, event.transfer);
      this.updateTrayProgress();
      this.updateTrayStatus();
    } else if (event.type === "batch-finished") {
      const parts: string[] = [];
      if (event.uploaded > 0) {
        parts.push(`${event.uploaded} file${event.uploaded === 1 ? "" : "s"} uploaded`);
      }
      if (event.downloaded > 0) {
        parts.push(`${event.downloaded} file${event.downloaded === 1 ? "" : "s"} downloaded`);
      }
      if (event.failed > 0) {
        parts.push(`${event.failed} file${event.failed === 1 ? "" : "s"} failed`);
      }
      if (parts.length > 0) this.notify("Lopload", parts.join(", "));
    }
    for (const fn of this.engineSubscribers) fn(event);
  }

  /** Tallies in-flight/failed transfers across every connection's engine —
   * shared by the tray tooltip (updateTrayProgress) and the tray menu status
   * line/Quit label/failure icon (updateTrayStatus). */
  private computeTrayAggregate(): {
    uploading: number;
    totalBytes: number;
    doneBytes: number;
    failed: number;
  } {
    let uploading = 0;
    let totalBytes = 0;
    let doneBytes = 0;
    let failed = 0;
    for (const t of this.transferSnapshots.values()) {
      if (t.state.kind === "queued" || t.state.kind === "sending" || t.state.kind === "checking") {
        uploading += 1;
        totalBytes += t.size;
        if (t.state.kind === "sending") doneBytes += t.size * (t.state.percent / 100);
        else if (t.state.kind === "checking") doneBytes += t.size;
      } else if (t.state.kind === "failed") {
        failed += 1;
      }
    }
    return { uploading, totalBytes, doneBytes, failed };
  }

  private updateTrayProgress(): void {
    const { uploading, totalBytes, doneBytes } = this.computeTrayAggregate();
    const fraction = uploading > 0 && totalBytes > 0 ? doneBytes / totalBytes : null;
    this.host.tray.setProgress(fraction);
  }

  /** Pushes the tray menu's status line, "Retry failed" count, and
   * transfer-aware Quit label — throttled on the src/tauri/tray.ts side. */
  private updateTrayStatus(): void {
    const { uploading, totalBytes, doneBytes, failed } = this.computeTrayAggregate();
    const percent = uploading > 0 && totalBytes > 0 ? (doneBytes / totalBytes) * 100 : 0;
    this.host.tray.setStatus({ uploading, percent, failed });
  }

  /**
   * Shared tracking harness behind every progress-reporting background
   * operation (rename/move, trash, restore, purge): mints a moveId, seeds an
   * initial MoveProgress, forwards `fn`'s CopyProgress events into
   * `moveSubscribers` (so TransferWidget shows it even if the dialog that
   * started it gets closed), and settles the tracked entry to "completed" or
   * "failed" once `fn` does. `fn` gets an `emit` callback rather than doing
   * this bookkeeping itself, so each caller only supplies the S3 call and
   * `kind` distinguishing what it's for.
   */
  private async runTracked(
    connectionId: string,
    fromKey: string,
    toKey: string,
    kind: MoveProgress["kind"],
    fn: (emit: (progress: CopyProgress) => void) => Promise<void>,
  ): Promise<void> {
    const moveId = crypto.randomUUID();
    const emit = (partial: Partial<MoveProgress>) => {
      const current = this.activeMoves.get(moveId);
      if (!current) return;
      const next: MoveProgress = { ...current, ...partial };
      this.activeMoves.set(moveId, next);
      for (const fn of this.moveSubscribers) fn(next);
    };

    const initial: MoveProgress = {
      moveId,
      connectionId,
      fromKey,
      toKey,
      kind,
      copiedBytes: 0,
      totalBytes: 0,
      copiedItems: 0,
      totalItems: 0,
      status: "moving",
    };
    this.activeMoves.set(moveId, initial);
    for (const fn of this.moveSubscribers) fn(initial);

    // A settled operation is the subscriber's to remember, not ours: the map
    // tracks what's in flight, so the terminal event goes out and then the
    // entry goes away rather than accumulating for the life of the process.
    try {
      await fn((p) => emit(p));
      const final = this.activeMoves.get(moveId);
      emit({
        status: "completed",
        copiedItems: final?.totalItems ?? 0,
        copiedBytes: final?.totalBytes ?? 0,
      });
      this.activeMoves.delete(moveId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      emit({ status: "failed", errorMessage: msg });
      this.activeMoves.delete(moveId);
      throw err;
    }
  }

  private findEngineFor(transferId: string): TransferEngine | undefined {
    for (const engine of this.engines.values()) {
      if (engine.getTransfer(transferId)) return engine;
    }
    return undefined;
  }

  /** Pushes the current saved connection list to the tray's "Upload
   * files…" submenu — called at startup and after any save/delete. */
  private async refreshTrayConnections(): Promise<void> {
    const store = await this.getConnectionStore();
    const list = await store.list();
    this.host.tray.setConnections(deriveTrayUploadTargets(list));
  }

  /** Listens once for a per-connection "Upload files…" tray click: opens the
   * native file picker and enqueues the chosen files to that connection's
   * last-browsed folder, using the same per-connection engine the app uses
   * when the user switches to it in the window. */
  startTrayUploadListening(): void {
    if (this.trayUploadListening) return;
    this.trayUploadListening = true;
    this.trayUploadUnsubscribe = this.host.tray.onUploadFilesRequested((connectionId) => {
      void this.handleTrayUpload(connectionId);
    });
  }

  private async handleTrayUpload(connectionId: string): Promise<void> {
    const store = await this.getConnectionStore();
    const conn = await store.get(connectionId);
    if (!conn) return;
    const files = await this.pickFiles();
    if (files.length === 0) return;
    await this.engine.enqueueFiles(connectionId, conn.lastPrefix, files);
  }

  // ---- ConnectionsService ----
  connections = {
    list: async (): Promise<Connection[]> => {
      const store = await this.getConnectionStore();
      const list = await store.list();
      this.host.tray.setConnections(deriveTrayUploadTargets(list));
      return list;
    },
    save: async (conn: Connection, credentials: Credentials): Promise<void> => {
      const store = await this.getConnectionStore();
      await store.save(conn);
      await this.host.keychain.set(conn.id, credentials);
      this.invalidateConnection(conn.id);
      await this.refreshTrayConnections();
    },
    delete: async (id: string): Promise<void> => {
      const store = await this.getConnectionStore();
      await store.delete(id);
      // A missing/broken keychain entry must never make a connection
      // undeletable — the row is already gone, so finish the cleanup.
      await this.host.keychain.delete(id).catch(() => {});
      this.invalidateConnection(id);
      await this.refreshTrayConnections();
    },
    setLastPrefix: async (id: string, prefix: string): Promise<void> => {
      const store = await this.getConnectionStore();
      await store.setLastPrefix(id, prefix);
    },
  };

  // ---- BrowserService ----
  browser = {
    list: async (connectionId: string, prefix: string): Promise<RemoteEntry[]> => {
      const { client, conn } = await this.getClient(connectionId);
      return listEntries(client, conn.bucket, prefix);
    },
    createFolder: async (connectionId: string, prefix: string, name: string): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      await s3CreateFolder(client, conn.bucket, `${prefix}${name}`);
    },
    rename: async (
      connectionId: string,
      key: string,
      newName: string,
      onProgress?: (progress: CopyProgress) => void,
    ): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      const toKey = renameKey(key, newName);
      if (isFolderKey(key)) {
        await s3RenameFolder(client, conn.bucket, key, toKey, onProgress);
      } else {
        await s3RenameFile(client, conn.bucket, key, toKey, onProgress);
      }
    },
    move: async (
      connectionId: string,
      key: string,
      toKey: string,
      onProgress?: (progress: CopyProgress) => void,
    ): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      await this.runTracked(connectionId, key, toKey, "move", async (emit) => {
        const progress = (p: CopyProgress) => {
          emit(p);
          onProgress?.(p);
        };
        if (isFolderKey(key)) {
          await s3RenameFolder(client, conn.bucket, key, toKey, progress);
        } else {
          await s3RenameFile(client, conn.bucket, key, toKey, progress);
        }
      });
    },
    subscribeMoves: (cb: (event: MoveProgress) => void): (() => void) => {
      this.moveSubscribers.add(cb);
      return () => this.moveSubscribers.delete(cb);
    },
    delete: async (connectionId: string, key: string): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      const deletedAtMs = Date.now();
      if (isFolderKey(key)) {
        await this.runTracked(connectionId, key, key, "trash", (emit) =>
          s3MoveFolderToTrash(client, conn.bucket, key, deletedAtMs, emit),
        );
      } else {
        await s3MoveFileToTrash(client, conn.bucket, key, deletedAtMs);
      }
    },
    copyLink: async (connectionId: string, key: string, expiresInSeconds: number): Promise<string> => {
      const { client, conn } = await this.getClient(connectionId);
      return s3CopyLink(client, conn.bucket, key, expiresInSeconds);
    },
    getThumbnailUrl: async (connectionId: string, key: string): Promise<string | null> => {
      const name = key.split("/").pop() ?? key;
      if (!isImageName(name)) return null;
      const { client, conn } = await this.getClient(connectionId);
      return s3CopyLink(client, conn.bucket, key, THUMBNAIL_URL_EXPIRY_SECONDS);
    },
    folderInfo: async (connectionId: string, key: string): Promise<FolderInfo> => {
      const { client, conn } = await this.getClient(connectionId);
      return folderStats(client, conn.bucket, key);
    },
    listFilesRecursive: async (
      connectionId: string,
      prefix: string,
    ): Promise<{ key: string; size: number }[]> => {
      const { client, conn } = await this.getClient(connectionId);
      return listFilesUnder(client, conn.bucket, prefix);
    },
  };

  // ---- TrashService ----
  trash = {
    list: async (connectionId: string): Promise<TrashItem[]> => {
      const { client, conn } = await this.getClient(connectionId);
      const groups = await s3ListTrash(client, conn.bucket);
      return groups.map((g) => ({
        id: `${g.deletedAtMs}:${g.originalKey}`,
        originalKey: g.originalKey,
        kind: g.kind,
        deletedAt: g.deletedAtMs,
        purgeAt: g.purgeAtMs,
        size: g.totalSize,
      }));
    },
    restore: async (
      connectionId: string,
      item: TrashItem,
      onProgress?: (progress: CopyProgress) => void,
    ): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      if (item.kind === "folder") {
        await this.runTracked(
          connectionId,
          item.originalKey,
          item.originalKey,
          "restore",
          async (emit) => {
            const progress = (p: CopyProgress) => {
              emit(p);
              onProgress?.(p);
            };
            await s3RestoreFolderFromTrash(client, conn.bucket, item.deletedAt, item.originalKey, progress);
          },
        );
      } else {
        await s3RestoreFileFromTrash(client, conn.bucket, item.deletedAt, item.originalKey);
      }
    },
    deleteNow: async (
      connectionId: string,
      item: TrashItem,
      onProgress?: (progress: CopyProgress) => void,
    ): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      if (item.kind === "folder") {
        await this.runTracked(
          connectionId,
          item.originalKey,
          item.originalKey,
          "purge",
          async (emit) => {
            const progress = (p: CopyProgress) => {
              emit(p);
              onProgress?.(p);
            };
            await s3DeleteTrashItem(client, conn.bucket, item.deletedAt, item.originalKey, item.kind, progress);
          },
        );
      } else {
        await s3DeleteTrashItem(client, conn.bucket, item.deletedAt, item.originalKey, item.kind);
      }
    },
    emptyTrash: async (
      connectionId: string,
      onProgress?: (progress: CopyProgress) => void,
    ): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      await this.runTracked(connectionId, "Trash", "Trash", "purge", async (emit) => {
        const progress = (p: CopyProgress) => {
          emit(p);
          onProgress?.(p);
        };
        await s3EmptyTrash(client, conn.bucket, progress);
      });
    },
  };

  // ---- EngineService ----
  engine = {
    listTransfers: async (connectionId: string): Promise<Transfer[]> => {
      const engine = await this.getEngine(connectionId);
      return engine.listTransfers();
    },
    subscribe: (cb: (event: EngineEvent) => void): (() => void) => {
      this.engineSubscribers.add(cb);
      return () => this.engineSubscribers.delete(cb);
    },
    enqueueFiles: async (
      connectionId: string,
      prefix: string,
      files: PickedFile[],
    ): Promise<void> => {
      const engine = await this.getEngine(connectionId);
      const toEnqueue: EnqueueFile[] = files.map((f) => ({
        localPath: f.path,
        size: f.size,
        key: `${prefix}${f.name}`,
        folderId: f.folderId,
        folderName: f.folderName,
      }));
      await engine.enqueue(toEnqueue);
    },
    enqueueDownloads: async (
      connectionId: string,
      targets: DownloadTarget[],
    ): Promise<void> => {
      const engine = await this.getEngine(connectionId);
      const toEnqueue: EnqueueFile[] = targets.map((t) => ({
        localPath: t.localPath,
        size: t.size,
        key: t.key,
      }));
      await engine.enqueueDownloads(toEnqueue);
    },
    dismiss: async (transferId: string): Promise<void> => {
      const engine = this.findEngineFor(transferId);
      engine?.acknowledge(transferId);
      await engine?.dismiss(transferId);
      this.transferSnapshots.delete(transferId);
      this.updateTrayStatus();
    },
    cancel: async (transferId: string): Promise<void> => {
      const engine = this.findEngineFor(transferId);
      await engine?.cancel(transferId);
      this.transferSnapshots.delete(transferId);
      this.updateTrayStatus();
    },
    abortStaleUploads: async (
      connectionId: string,
    ): Promise<{ aborted: number; errors: number }> => {
      const { client, conn } = await this.getClient(connectionId);
      const store = await this.getTransferStore();
      return abortStaleUploads(client, conn.bucket, store, connectionId);
    },
  };

  // ---- KeychainService (test-connection) ----
  keychain = {
    testConnection: async (draft: ConnectionDraft): Promise<TestConnectionResult> => {
      try {
        const client = createS3Client(
          { endpoint: draft.endpoint, region: draft.region },
          { accessKey: draft.accessKey, secretKey: draft.secretKey },
          this.host.fetch,
        );
        const result = await s3TestConnection(client, draft.bucket);
        if (result.ok) {
          return { ok: true, message: "Connection works." };
        }
        return { ok: false, message: result.error.message };
      } catch (err) {
        log.warn("testConnection threw unexpectedly", err);
        return { ok: false, message: "Something went wrong while testing the connection." };
      }
    },
  };

  // ---- UpdatesService ----
  updates = {
    checkForUpdate: (): Promise<string | null> => this.host.updates.checkForUpdate(),
    downloadUpdate: (onProgress: (percent: number) => void): Promise<void> =>
      this.host.updates.downloadUpdate(onProgress),
    relaunchApp: (): Promise<void> => this.host.updates.relaunchApp(),
    isAutoUpdateEnabled: (): Promise<boolean> => this.host.settings.isAutoUpdateEnabled(),
    setAutoUpdateEnabled: (enabled: boolean): Promise<void> =>
      this.host.settings.setAutoUpdateEnabled(enabled),
  };

  // ---- SettingsService ----
  settings = {
    getDefaultDownloadDir: (): Promise<string | null> =>
      this.host.settings.getDefaultDownloadDir(),
    setDefaultDownloadDir: (path: string | null): Promise<void> =>
      this.host.settings.setDefaultDownloadDir(path),
    getTransferTuning: (): Promise<TransferTuning> => this.host.settings.getTransferTuning(),
    setTransferTuning: async (tuning: TransferTuning): Promise<void> => {
      await this.host.settings.setTransferTuning(tuning);
      this.tuning = tuning;
      this.tuningLoaded = true;
    },
    getLastConnectionId: (): Promise<string | null> => this.host.settings.getLastConnectionId(),
    setLastConnectionId: (id: string): Promise<void> =>
      this.host.settings.setLastConnectionId(id),
  };

  // ---- misc AppServices members ----

  async pickFiles(): Promise<PickedFile[]> {
    const paths = await this.host.dialogs.pickFiles();
    return Promise.all(
      paths.map(async (path) => {
        const size = await this.host.files.size(path);
        return { path, name: path.split(/[/\\]/).pop() ?? path, size };
      }),
    );
  }

  async pickSaveDestination(defaultName: string): Promise<string | null> {
    const downloadDir = await this.host.settings.getDefaultDownloadDir();
    const defaultPath = downloadDir
      ? await this.host.files.join(downloadDir, defaultName)
      : defaultName;
    return this.host.dialogs.pickSaveDestination(defaultPath);
  }

  async pickDownloadDirectory(): Promise<string | null> {
    const downloadDir = await this.host.settings.getDefaultDownloadDir();
    return this.host.dialogs.pickDirectory(downloadDir ?? undefined);
  }

  async openFile(connectionId: string, key: string, name: string): Promise<void> {
    const dir = await this.host.files.tempDir();
    const localPath = `${dir}/lopload-open-${crypto.randomUUID()}-${name}`;
    const engine = await this.getEngine(connectionId);
    const [transfer] = await engine.enqueueDownloads([{ key, localPath, size: 0 }]);
    await new Promise<void>((resolve) => {
      const unsubscribe = engine.subscribe((event) => {
        if (event.type !== "transfer-updated" || event.transfer.id !== transfer.id) return;
        if (event.transfer.state.kind === "downloaded") {
          unsubscribe();
          resolve();
          void this.host.shell.openPath(localPath);
        } else if (event.transfer.state.kind === "failed") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  async revealInFinder(path: string): Promise<void> {
    await this.host.shell.revealItemInDir(path);
  }

  onFileDrop(
    cb: (files: PickedFile[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    return this.host.onFileDrop((paths) => {
      this.expandAndEmit(paths, cb, onError).catch((err) => {
        // A dropped folder that can't be walked (e.g. an unreadable
        // subdirectory, or a path outside what the OS lets this app
        // enumerate) must not silently do nothing — surface it so the
        // user knows the drop didn't queue anything.
        log.error("Failed to expand dropped paths:", err);
        this.notify(
          "Lopload",
          "Couldn't read one or more of the dropped items - nothing was added.",
        );
        onError?.(String(err));
      });
    });
  }

  private async expandAndEmit(
    paths: string[],
    cb: (files: PickedFile[]) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    const { files, skipped } = await expandDroppedPaths(
      paths,
      (path: string) => this.host.files.isDirectory(path),
      {
        readDir: (path: string): Promise<DropDirEntry[]> => this.host.files.readDir(path),
        size: (path: string) => this.host.files.size(path),
        joinPath: (dirPath: string, childName: string) => `${dirPath}/${childName}`,
      },
    );
    if (skipped.length > 0) {
      log.warn("Skipped unreadable dropped items:", skipped);
      onError?.(
        `${skipped.length} item${skipped.length === 1 ? "" : "s"} couldn't be read and ${skipped.length === 1 ? "was" : "were"} skipped.`,
      );
    }
    // `name` here is the "/"-joined relative path computed by
    // expandDroppedPaths (includes the dropped folder's own name for
    // nested files), so the remote key built as `prefix + name` preserves
    // folder structure. `size` is the real file size, not a placeholder.
    if (files.length > 0) {
      cb(
        files.map((f) => ({
          path: f.path,
          name: f.name,
          size: f.size,
          folderId: f.folderId,
          folderName: f.folderName,
        })),
      );
    }
  }

  setBadgeCount(count: number): void {
    // A zero badge must clear the dock indicator, not render a "0" on it.
    this.host.tray.setBadgeCount(count > 0 ? count : null);
  }

  notify(title: string, body: string): void {
    void this.host.notify(title, body).catch((err) => log.warn("notify failed", err));
  }

  /** Runs the silent trash purge sweep now, and every 24h thereafter. Call once at startup. */
  startTrashSweep(): void {
    if (this.trashSweepStarted) return;
    this.trashSweepStarted = true;
    const run = () => void this.sweepAllConnectionsTrash();
    run();
    this.trashSweepTimer = setInterval(run, TRASH_SWEEP_INTERVAL_MS);
  }

  /**
   * Stops everything this instance started. The app never calls it — it lives
   * as long as the process — but anything that builds services per scenario
   * must, or the leftovers outlive their scenario.
   *
   * Two things leak without it. The trash sweep keeps a 24h timer alive and
   * goes on sweeping a bucket nobody cares about any more. And, more subtly, a
   * transfer that's still in flight keeps running — and keeps writing rows to a
   * store the next caller is about to reuse. In the app that's harmless (one
   * instance, one process). In the in-app self-test it isn't: every scenario
   * shares one real SQLite database, so a straggler's late save() lands *after*
   * the next scenario has reset the tables, and that scenario's
   * resumePending() then dutifully picks the zombie back up.
   */
  async dispose(): Promise<void> {
    if (this.trashSweepTimer !== null) clearInterval(this.trashSweepTimer);
    this.trashSweepTimer = null;

    if (this.trayUploadUnsubscribe) {
      this.trayUploadUnsubscribe();
      this.trayUploadUnsubscribe = null;
    }
    this.trayUploadListening = false;

    const engines = [...this.engines.values()];
    this.engines.clear();
    this.enginePromises.clear();
    this.clients.clear();

    await Promise.all(
      engines.flatMap((engine) =>
        engine
          .listTransfers()
          .filter(
            (t) =>
              t.state.kind === "queued" ||
              t.state.kind === "sending" ||
              t.state.kind === "checking",
          )
          // A cancel that fails has nothing left to tell us — we're tearing the
          // whole instance down either way.
          .map((t) => engine.cancel(t.id).catch(() => {})),
      ),
    );

    this.engineSubscribers.clear();
    this.moveSubscribers.clear();
    this.transferSnapshots.clear();
  }

  private async sweepAllConnectionsTrash(): Promise<void> {
    try {
      const store = await this.getConnectionStore();
      const connections = await store.list();
      await Promise.all(
        connections.map(async (conn) => {
          try {
            const { client } = await this.getClient(conn.id);
            await sweepTrash(client, conn.bucket, Date.now());
          } catch (err) {
            log.warn("Trash sweep failed for connection", conn.id, err);
          }
        }),
      );
    } catch (err) {
      log.warn("Trash sweep: store iteration failed", err);
    }
  }
}

/** AppServices plus the teardown hook only a test caller needs. */
export interface Services extends AppServices {
  dispose(): Promise<void>;
}

/** Builds the real AppServices implementation against a Host. The app passes
 * createTauriHost() (and does so once — see src/App.tsx); tests pass
 * createNodeHost() and build a fresh one per scenario, calling dispose()
 * afterwards. */
export function createAppServices(host: Host): Services {
  const services = new LoploadServices(host);
  services.startTrashSweep();
  services.startTrayUploadListening();
  void host.initLogSink();
  return services;
}
