// Real AppServices implementation, wiring the framework-free engine
// (src/lib) and the thin Tauri wrappers (src/tauri) into the shape the UI
// expects (src/ui/services.ts). This is the only file that should know
// about *both* the engine internals and the Tauri APIs at once.
//
// Kept deliberately "boring": every UI-facing method is a thin adapter that
// resolves a per-connection S3Client/TransferEngine (lazily, cached) and
// calls straight into src/lib. Anything with real logic (folder-drop
// expansion) is factored out into a pure, separately-unit-tested module.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readDir, size as fileSize, stat } from "@tauri-apps/plugin-fs";
import { tempDir } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import type { S3Client } from "@aws-sdk/client-s3";

import type {
  Connection,
  ConnectionStore,
  Credentials,
  EngineEvent,
  RemoteEntry,
  Transfer,
  TransferStore,
} from "../lib/types";
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
import { sweepOrphans } from "../lib/s3/orphans";
import { sweepTrash } from "../lib/s3/trashSweep";
import {
  loadDatabase,
  SqliteConnectionStore,
  SqliteTransferStore,
} from "../lib/stores/sqlite";
import { keychainDelete, keychainGet, keychainSet } from "../tauri/keychain";
import { tauriFetch } from "../tauri/http";
import { tauriFileReader, tauriFileWriter } from "../tauri/fs";
import {
  onCopyLinkRequested,
  onRetryFailedRequested,
  onUploadFilesRequested,
  setTrayConnections,
  setTrayLastUpload,
  setTrayStatus,
} from "../tauri/tray";
import { deriveTrayUploadTargets, trackLastUploaded, type LastUploadedFile } from "./trayState";
import { checkForUpdate, installAndRelaunch } from "../tauri/updater";
import { isImageName, isVideoName } from "../ui/format";
import { CredentialsUnreadableError } from "../ui/services";
import type {
  AppServices,
  ConnectionDraft,
  DownloadTarget,
  FolderInfo,
  PickedFile,
  TestConnectionResult,
  TrashItem,
} from "../ui/services";
import { expandDroppedPaths, type DropDirEntry } from "./dragDropExpand";

const ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TRASH_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** True when running inside the Tauri webview (vs. a plain browser tab). */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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

class RealServices implements AppServices {
  private dbPromise: ReturnType<typeof loadDatabase> | null = null;
  private connectionStorePromise: Promise<ConnectionStore> | null = null;
  private transferStorePromise: Promise<TransferStore> | null = null;

  /** Cached per-connection S3 clients, invalidated on credential/connection changes. */
  private clients = new Map<string, S3Client>();
  /** Cached per-connection engines, created lazily on first use (a "switch to"). */
  private engines = new Map<string, TransferEngine>();

  private engineSubscribers = new Set<(event: EngineEvent) => void>();
  /** Latest known state of every transfer across all engines, for tray progress. */
  private transferSnapshots = new Map<string, Transfer>();

  private orphanSweepStarted = false;
  private trashSweepStarted = false;
  private trayRetryListening = false;
  private trayUploadListening = false;
  private trayCopyLinkListening = false;
  /** Most recently verified upload, for the tray's "Copy link — <file>" item. */
  private lastUploaded: LastUploadedFile | null = null;

  private async getDb() {
    if (!this.dbPromise) this.dbPromise = loadDatabase();
    return this.dbPromise;
  }

  private async getConnectionStore(): Promise<ConnectionStore> {
    if (!this.connectionStorePromise) {
      this.connectionStorePromise = this.getDb().then(
        (db) => new SqliteConnectionStore(db),
      );
    }
    return this.connectionStorePromise;
  }

  private async getTransferStore(): Promise<TransferStore> {
    if (!this.transferStorePromise) {
      this.transferStorePromise = this.getDb().then(
        (db) => new SqliteTransferStore(db),
      );
    }
    return this.transferStorePromise;
  }

  private async getClient(connectionId: string): Promise<{ client: S3Client; conn: Connection }> {
    const store = await this.getConnectionStore();
    const conn = await store.get(connectionId);
    if (!conn) throw new Error(`Unknown connection: ${connectionId}`);
    let client = this.clients.get(connectionId);
    if (!client) {
      const credentials = await keychainGet(connectionId);
      if (!credentials) throw new CredentialsUnreadableError(connectionId);
      client = createS3Client(conn, credentials, tauriFetch);
      this.clients.set(connectionId, client);
    }
    return { client, conn };
  }

  private invalidateConnection(connectionId: string): void {
    this.clients.delete(connectionId);
    this.engines.delete(connectionId);
  }

  private async getEngine(connectionId: string): Promise<TransferEngine> {
    let engine = this.engines.get(connectionId);
    if (engine) return engine;
    const { client, conn } = await this.getClient(connectionId);
    const store = await this.getTransferStore();
    engine = new TransferEngine({
      client,
      bucket: conn.bucket,
      connectionId,
      reader: tauriFileReader,
      writer: tauriFileWriter,
      store,
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
      const nextLastUploaded = trackLastUploaded(this.lastUploaded, event);
      if (nextLastUploaded !== this.lastUploaded) {
        this.lastUploaded = nextLastUploaded;
        setTrayLastUpload(nextLastUploaded?.name ?? null);
      }
    } else if (event.type === "batch-finished") {
      const parts: string[] = [];
      if (event.uploaded > 0) {
        parts.push(`${event.uploaded} file${event.uploaded === 1 ? "" : "s"} uploaded`);
      }
      if (event.downloaded > 0) {
        parts.push(`${event.downloaded} file${event.downloaded === 1 ? "" : "s"} downloaded`);
      }
      if (event.failed > 0) {
        parts.push(`${event.failed} file${event.failed === 1 ? "" : "s"} failed — open Lopload to retry`);
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
    void invoke("tray_set_progress", { fraction }).catch(() => {});
  }

  /** Pushes the tray menu's status line, "Retry failed" count, and
   * transfer-aware Quit label — throttled on the src/tauri/tray.ts side. */
  private updateTrayStatus(): void {
    const { uploading, totalBytes, doneBytes, failed } = this.computeTrayAggregate();
    const percent = uploading > 0 && totalBytes > 0 ? (doneBytes / totalBytes) * 100 : 0;
    setTrayStatus({ uploading, percent, failed });
  }

  /** Listens once for the tray's "Retry failed" click and replays it as a
   * retry() on every currently-failed transfer across all engines. */
  startTrayRetryListening(): void {
    if (this.trayRetryListening) return;
    this.trayRetryListening = true;
    onRetryFailedRequested(() => {
      for (const [id, transfer] of this.transferSnapshots) {
        if (transfer.state.kind !== "failed") continue;
        const engine = this.findEngineFor(id);
        void engine?.retry(id);
      }
    });
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
    setTrayConnections(deriveTrayUploadTargets(list));
  }

  /** Listens once for a per-connection "Upload files…" tray click: opens the
   * native file picker and enqueues the chosen files to that connection's
   * last-browsed folder, using the same per-connection engine the app uses
   * when the user switches to it in the window. */
  startTrayUploadListening(): void {
    if (this.trayUploadListening) return;
    this.trayUploadListening = true;
    onUploadFilesRequested((connectionId) => {
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

  /** Listens once for the tray's "Copy link" click and copies the link for
   * whichever upload trackLastUploaded() last recorded as verified. */
  startTrayCopyLinkListening(): void {
    if (this.trayCopyLinkListening) return;
    this.trayCopyLinkListening = true;
    onCopyLinkRequested(() => {
      void this.handleTrayCopyLink();
    });
  }

  private async handleTrayCopyLink(): Promise<void> {
    const file = this.lastUploaded;
    if (!file) return;
    const link = await this.browser.copyLink(file.connectionId, file.key);
    await navigator.clipboard?.writeText(link);
    this.notify("Lopload", `Copied link for ${file.name}`);
  }

  // ---- ConnectionsService ----
  connections = {
    list: async (): Promise<Connection[]> => {
      const store = await this.getConnectionStore();
      const list = await store.list();
      setTrayConnections(deriveTrayUploadTargets(list));
      return list;
    },
    save: async (conn: Connection, credentials: Credentials): Promise<void> => {
      const store = await this.getConnectionStore();
      await store.save(conn);
      await keychainSet(conn.id, credentials);
      this.invalidateConnection(conn.id);
      await this.refreshTrayConnections();
    },
    delete: async (id: string): Promise<void> => {
      const store = await this.getConnectionStore();
      await store.delete(id);
      // A missing/broken keychain entry must never make a connection
      // undeletable — the row is already gone, so finish the cleanup.
      await keychainDelete(id).catch(() => {});
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
    rename: async (connectionId: string, key: string, newName: string): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      const toKey = renameKey(key, newName);
      if (isFolderKey(key)) {
        await s3RenameFolder(client, conn.bucket, key, toKey);
      } else {
        await s3RenameFile(client, conn.bucket, key, toKey);
      }
    },
    move: async (connectionId: string, key: string, toKey: string): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      if (isFolderKey(key)) {
        await s3RenameFolder(client, conn.bucket, key, toKey);
      } else {
        await s3RenameFile(client, conn.bucket, key, toKey);
      }
    },
    delete: async (connectionId: string, key: string): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      const deletedAtMs = Date.now();
      if (isFolderKey(key)) {
        await s3MoveFolderToTrash(client, conn.bucket, key, deletedAtMs);
      } else {
        await s3MoveFileToTrash(client, conn.bucket, key, deletedAtMs);
      }
    },
    copyLink: async (connectionId: string, key: string): Promise<string> => {
      const { client, conn } = await this.getClient(connectionId);
      return s3CopyLink(client, conn.bucket, key);
    },
    getThumbnailUrl: async (connectionId: string, key: string): Promise<string | null> => {
      const name = key.split("/").pop() ?? key;
      if (!isImageName(name) && !isVideoName(name)) return null;
      const { client, conn } = await this.getClient(connectionId);
      return s3CopyLink(client, conn.bucket, key);
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
    restore: async (connectionId: string, item: TrashItem): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      if (item.kind === "folder") {
        await s3RestoreFolderFromTrash(client, conn.bucket, item.deletedAt, item.originalKey);
      } else {
        await s3RestoreFileFromTrash(client, conn.bucket, item.deletedAt, item.originalKey);
      }
    },
    deleteNow: async (connectionId: string, item: TrashItem): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      await s3DeleteTrashItem(client, conn.bucket, item.deletedAt, item.originalKey, item.kind);
    },
    emptyTrash: async (connectionId: string): Promise<void> => {
      const { client, conn } = await this.getClient(connectionId);
      await s3EmptyTrash(client, conn.bucket);
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
    retry: async (transferId: string): Promise<void> => {
      const engine = this.findEngineFor(transferId);
      await engine?.retry(transferId);
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
      engine?.cancel(transferId);
    },
  };

  // ---- KeychainService (test-connection) ----
  keychain = {
    testConnection: async (draft: ConnectionDraft): Promise<TestConnectionResult> => {
      try {
        const client = createS3Client(
          { endpoint: draft.endpoint, region: draft.region },
          { accessKey: draft.accessKey, secretKey: draft.secretKey },
          tauriFetch,
        );
        const result = await s3TestConnection(client, draft.bucket);
        if (result.ok) {
          return { ok: true, message: "Connection works." };
        }
        return { ok: false, message: result.error.message };
      } catch {
        return { ok: false, message: "Something went wrong while testing the connection." };
      }
    },
  };

  // ---- UpdatesService ----
  updates = {
    checkForUpdate: (): Promise<string | null> => checkForUpdate(),
    installAndRelaunch: (): Promise<void> => installAndRelaunch(),
  };

  // ---- misc AppServices members ----

  async pickFiles(): Promise<PickedFile[]> {
    const selection = await openDialog({ multiple: true, directory: false });
    if (!selection) return [];
    const paths = Array.isArray(selection) ? selection : [selection];
    const files: PickedFile[] = [];
    for (const path of paths) {
      const size = await fileSize(path);
      files.push({ path, name: path.split(/[/\\]/).pop() ?? path, size });
    }
    return files;
  }

  async pickSaveDestination(defaultName: string): Promise<string | null> {
    const destination = await saveDialog({ defaultPath: defaultName });
    return destination ?? null;
  }

  async pickDownloadDirectory(): Promise<string | null> {
    const selection = await openDialog({ multiple: false, directory: true });
    if (!selection) return null;
    return Array.isArray(selection) ? (selection[0] ?? null) : selection;
  }

  async openFile(connectionId: string, key: string, name: string): Promise<void> {
    const dir = await tempDir();
    const localPath = `${dir}/lopload-open-${crypto.randomUUID()}-${name}`;
    const engine = await this.getEngine(connectionId);
    const [transfer] = await engine.enqueueDownloads([{ key, localPath, size: 0 }]);
    await new Promise<void>((resolve) => {
      const unsubscribe = engine.subscribe((event) => {
        if (event.type !== "transfer-updated" || event.transfer.id !== transfer.id) return;
        if (event.transfer.state.kind === "downloaded") {
          unsubscribe();
          resolve();
          void openPath(localPath);
        } else if (event.transfer.state.kind === "failed") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  onFileDrop(
    cb: (files: PickedFile[]) => void,
    onError?: (message: string) => void,
  ): () => void {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        this.expandAndEmit(event.payload.paths, cb, onError).catch((err) => {
          // A dropped folder that can't be walked (e.g. an unreadable
          // subdirectory, or a path outside what the OS lets this app
          // enumerate) must not silently do nothing — surface it so the
          // user knows the drop didn't queue anything.
          console.error("Failed to expand dropped paths:", err);
          this.notify(
            "Lopload",
            "Couldn't read one or more of the dropped items — nothing was added.",
          );
          onError?.(String(err));
        });
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  private async expandAndEmit(
    paths: string[],
    cb: (files: PickedFile[]) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    const isDirectory = async (path: string): Promise<boolean> => {
      const info = await stat(path);
      return info.isDirectory;
    };
    const { files, skipped } = await expandDroppedPaths(paths, isDirectory, {
      readDir: async (path: string): Promise<DropDirEntry[]> => {
        const entries = await readDir(path);
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
      },
      size: (path: string) => fileSize(path),
      joinPath: (dirPath: string, childName: string) => `${dirPath}/${childName}`,
    });
    if (skipped.length > 0) {
      console.error("Skipped unreadable dropped items:", skipped);
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
    void invoke("set_badge_count", { count: count > 0 ? count : null }).catch(() => {});
  }

  notify(title: string, body: string): void {
    import("../tauri/notify").then(() => {
      // notifyBatchFinished is shaped for the batch-summary case; for the
      // general notify() contract, send directly via the notification plugin.
    });
    void this.sendNotification(title, body);
  }

  private async sendNotification(title: string, body: string): Promise<void> {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (!granted) return;
    sendNotification({ title, body });
  }

  /** Runs the silent orphan sweep now, and every 24h thereafter. Call once at startup. */
  startOrphanSweep(): void {
    if (this.orphanSweepStarted) return;
    this.orphanSweepStarted = true;
    const run = () => void this.sweepAllConnections();
    run();
    setInterval(run, ORPHAN_SWEEP_INTERVAL_MS);
  }

  private async sweepAllConnections(): Promise<void> {
    try {
      const store = await this.getConnectionStore();
      const transferStore = await this.getTransferStore();
      const connections = await store.list();
      for (const conn of connections) {
        try {
          const { client } = await this.getClient(conn.id);
          await sweepOrphans(client, transferStore, conn.id, conn.bucket, Date.now());
        } catch {
          // Silent per PLAN.md #7 — a single connection's failure (e.g. no
          // stored credentials yet) must not affect the others.
        }
      }
    } catch {
      // Silent.
    }
  }

  /** Runs the silent trash purge sweep now, and every 24h thereafter. Modeled
   * exactly on startOrphanSweep(). Call once at startup. */
  startTrashSweep(): void {
    if (this.trashSweepStarted) return;
    this.trashSweepStarted = true;
    const run = () => void this.sweepAllConnectionsTrash();
    run();
    setInterval(run, TRASH_SWEEP_INTERVAL_MS);
  }

  private async sweepAllConnectionsTrash(): Promise<void> {
    try {
      const store = await this.getConnectionStore();
      const connections = await store.list();
      for (const conn of connections) {
        try {
          const { client } = await this.getClient(conn.id);
          await sweepTrash(client, conn.bucket, Date.now());
        } catch {
          // Silent, same as the orphan sweep — one connection's failure
          // must not affect the others.
        }
      }
    } catch {
      // Silent.
    }
  }
}

let singleton: RealServices | null = null;

/** Builds (once) the real AppServices implementation and starts the silent
 * orphan sweep. Only valid inside the Tauri webview — see isTauriRuntime(). */
export function createRealServices(): AppServices {
  if (!singleton) {
    singleton = new RealServices();
    singleton.startOrphanSweep();
    singleton.startTrashSweep();
    singleton.startTrayRetryListening();
    singleton.startTrayUploadListening();
    singleton.startTrayCopyLinkListening();
  }
  return singleton;
}
