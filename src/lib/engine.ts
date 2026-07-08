// TransferEngine: drives the state machine
// queued → sending(percent) → checking → uploaded | downloaded | failed
// with concurrency 3, persisting every state change and emitting
// EngineEvents to subscribers. Framework-free — no React, no Tauri.
//
// One engine instance handles both directions for a connection: `direction`
// on each Transfer picks which of uploadTransfer/downloadTransfer actually
// moves the bytes, but queueing, concurrency, persistence, and the failure/
// cancel machinery are all shared rather than duplicated.

import type { S3Client } from "@aws-sdk/client-s3";

import type {
  EngineEvent,
  ErrorClass,
  Transfer,
  TransferState,
  TransferStore,
} from "./types";
import { createLogger } from "./logger";
import { classifyError } from "./errors";

const log = createLogger("engine");
import {
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "./s3/multipart";
import { downloadTransfer, type LocalFileWriter } from "./s3/download";

/** Valid next states for each current state — invalid transitions are rejected. */
export const STATE_TRANSITIONS: Record<
  TransferState["kind"],
  TransferState["kind"][]
> = {
  queued: ["sending", "failed"],
  sending: ["sending", "checking", "failed"],
  checking: ["uploaded", "downloaded", "failed"],
  uploaded: [],
  downloaded: [],
  failed: ["queued"],
};

export function canTransition(from: TransferState, to: TransferState): boolean {
  return STATE_TRANSITIONS[from.kind].includes(to.kind);
}

export class InvalidTransitionError extends Error {
  constructor(from: TransferState, to: TransferState) {
    super(`Invalid transfer state transition: ${from.kind} -> ${to.kind}`);
    this.name = "InvalidTransitionError";
  }
}

const CONCURRENCY = 3;

export interface EnqueueFile {
  /** Source path (upload) or destination path (download) on the local disk. */
  localPath: string;
  size: number;
  /** Remote key this file uploads to or downloads from. */
  key: string;
  /** Shared by every file from the same dropped/picked folder — copied onto
   *  the created Transfer so the UI can group them into one row. */
  folderId?: string;
  folderName?: string;
}

export interface TransferEngineDeps {
  client: S3Client;
  bucket: string;
  connectionId: string;
  reader: LocalFileReader;
  store: TransferStore;
  /** Required only if this engine will ever be asked to enqueueDownloads. */
  writer?: LocalFileWriter;
  concurrency?: number;
  now?: () => number;
  /** Injectable id generator for deterministic tests. */
  idGenerator?: () => string;
}

export class TransferEngine {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly connectionId: string;
  private readonly reader: LocalFileReader;
  private readonly writer?: LocalFileWriter;
  private readonly store: TransferStore;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  private readonly transfers = new Map<string, Transfer>();
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private readonly subscribers = new Set<(event: EngineEvent) => void>();
  private readonly acknowledged = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  /** Transfer ids cancel() was called on. Entries are never removed: within
   * one engine instance a cancelled transfer is done for good (it's already
   * out of `transfers`/`queue`/`active`, so nothing can restart it here) —
   * this set exists purely to stop a stray in-flight rejection or a late
   * fire-and-forget progress update from being mistaken for a real failure
   * or silently resurrecting the transfer after the fact. */
  private readonly cancelledIds = new Set<string>();
  /** Per-transfer speed tracking: last byte count + wall-clock timestamp. */
  private readonly speedTrackers = new Map<string, { lastBytes: number; lastTime: number }>();

  private batchUploaded = 0;
  private batchDownloaded = 0;
  private batchFailed = 0;
  private pumping = false;

  constructor(deps: TransferEngineDeps) {
    this.client = deps.client;
    this.bucket = deps.bucket;
    this.connectionId = deps.connectionId;
    this.reader = deps.reader;
    this.writer = deps.writer;
    this.store = deps.store;
    this.concurrency = deps.concurrency ?? CONCURRENCY;
    this.now = deps.now ?? (() => Date.now());
    this.idGenerator = deps.idGenerator ?? (() => crypto.randomUUID());
  }

  subscribe(fn: (event: EngineEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: EngineEvent): void {
    for (const fn of this.subscribers) fn(event);
  }

  getTransfer(id: string): Transfer | undefined {
    return this.transfers.get(id);
  }

  listTransfers(): Transfer[] {
    return Array.from(this.transfers.values());
  }

  hasUnacknowledgedFailures(): boolean {
    for (const t of this.transfers.values()) {
      if (t.state.kind === "failed" && !this.acknowledged.has(t.id)) return true;
    }
    return false;
  }

  /** Queue new files for upload under this connection's bucket. */
  async enqueue(files: EnqueueFile[]): Promise<Transfer[]> {
    return this.enqueueInternal(files, "upload");
  }

  /** Queue new remote files for download to a local destination path each. */
  async enqueueDownloads(files: EnqueueFile[]): Promise<Transfer[]> {
    return this.enqueueInternal(files, "download");
  }

  private async enqueueInternal(
    files: EnqueueFile[],
    direction: Transfer["direction"],
  ): Promise<Transfer[]> {
    const created: Transfer[] = [];
    for (const file of files) {
      const t = this.now();
      const transfer: Transfer = {
        id: this.idGenerator(),
        connectionId: this.connectionId,
        key: file.key,
        localPath: file.localPath,
        size: file.size,
        folderId: file.folderId,
        folderName: file.folderName,
        direction,
        state: { kind: "queued" },
        createdAt: t,
        updatedAt: t,
      };
      await this.store.save(transfer);
      this.transfers.set(transfer.id, transfer);
      this.queue.push(transfer.id);
      this.emit({ type: "transfer-updated", transfer: { ...transfer } });
      created.push(transfer);
      log.debug("enqueued", direction, transfer.key, transfer.id);
    }
    void this.pump();
    return created;
  }

  /** Retry a failed transfer. */
  async retry(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.state.kind !== "failed") return;
    log.info("retry", transfer.key, transfer.id);
    this.acknowledged.delete(transferId);
    await this.setState(transfer, { kind: "queued" });
    this.queue.push(transferId);
    void this.pump();
  }

  /** Mark a failed transfer as seen (clears badge/notification urgency, stays visible). */
  acknowledge(transferId: string): void {
    this.acknowledged.add(transferId);
  }

  /** Remove a failed (acknowledged) transfer from the list entirely. */
  async dismiss(transferId: string): Promise<void> {
    this.transfers.delete(transferId);
    this.acknowledged.delete(transferId);
    await this.store.delete(transferId);
  }

  /**
   * Cancels a queued or in-flight transfer: drops it from the queue/active
   * set and this session's transfer list, aborts its in-flight request
   * (if any), and deletes its persisted record so it won't be re-queued on
   * the next app launch.
   */
  async cancel(transferId: string): Promise<void> {
    const t = this.transfers.get(transferId);
    log.info("cancel", t?.key ?? transferId, transferId);
    this.cancelledIds.add(transferId);
    const controller = this.abortControllers.get(transferId);
    controller?.abort();
    this.abortControllers.delete(transferId);
    this.speedTrackers.delete(transferId);
    const queueIdx = this.queue.indexOf(transferId);
    if (queueIdx !== -1) this.queue.splice(queueIdx, 1);
    this.active.delete(transferId);
    this.transfers.delete(transferId);
    await this.store.delete(transferId);
  }

  /**
   * Reload transfers left in the store from a previous session. Non-terminal
   * transfers (queued/sending/checking) are marked as failed so the user can
   * see them and decide to retry, rather than silently re-queuing with zero
   * progress.
   */
  async resumePending(): Promise<void> {
    const all = await this.store.list(this.connectionId);
    for (const transfer of all) {
      if (
        transfer.state.kind === "queued" ||
        transfer.state.kind === "sending" ||
        transfer.state.kind === "checking"
      ) {
        transfer.state = { kind: "failed", errorClass: "unknown" };
        transfer.updatedAt = this.now();
        await this.store.save(transfer);
      }
      this.transfers.set(transfer.id, transfer);
    }
  }

  private async setState(transfer: Transfer, next: TransferState): Promise<void> {
    if (!canTransition(transfer.state, next)) {
      log.warn("invalid transition", transfer.id, transfer.state.kind, "->", next.kind);
      throw new InvalidTransitionError(transfer.state, next);
    }
    transfer.state = next;
    transfer.updatedAt = this.now();
    await this.store.save(transfer);
    // A fire-and-forget onProgress call (from uploadTransfer/downloadTransfer)
    // can still be resolving its store.save() after cancel() has already
    // dropped this transfer — without this check, that stale continuation
    // would silently re-insert it into the live transfer list.
    if (this.cancelledIds.has(transfer.id)) return;
    this.transfers.set(transfer.id, transfer);
    // Snapshot for the event — `transfer` keeps mutating in place, so
    // subscribers must not receive a reference that changes under them.
    this.emit({ type: "transfer-updated", transfer: { ...transfer } });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.active.size < this.concurrency) {
        const id = this.queue.shift();
        if (id === undefined) break;
        if (this.active.has(id)) continue;
        this.active.add(id);
        void this.runTransfer(id).finally(() => {
          this.active.delete(id);
          void this.pump();
          this.maybeEmitBatchFinished();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private maybeEmitBatchFinished(): void {
    if (this.active.size === 0 && this.queue.length === 0 &&
        (this.batchUploaded > 0 || this.batchDownloaded > 0 || this.batchFailed > 0)) {
      this.emit({
        type: "batch-finished",
        uploaded: this.batchUploaded,
        downloaded: this.batchDownloaded,
        failed: this.batchFailed,
      });
      this.batchUploaded = 0;
      this.batchDownloaded = 0;
      this.batchFailed = 0;
    }
  }

  private async runTransfer(id: string): Promise<void> {
    const transfer = this.transfers.get(id) ?? (await this.store.get(id)) ?? undefined;
    if (!transfer) return;
    this.transfers.set(id, transfer);

    const controller = new AbortController();
    this.abortControllers.set(id, controller);

    try {
      if (transfer.state.kind === "queued") {
        await this.setState(transfer, { kind: "sending", percent: 0 });
      } else if (transfer.state.kind !== "sending" && transfer.state.kind !== "checking") {
        return;
      } else if (transfer.state.kind === "checking") {
        await this.setState(transfer, { kind: "sending", percent: 0 });
      }

      const onProgress = (sent: number, total: number) => {
        const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 100;
        let speedBytesPerSec: number | undefined;
        const tracker = this.speedTrackers.get(id);
        const now = Date.now();
        if (tracker) {
          const elapsedMs = now - tracker.lastTime;
          const bytesDelta = sent - tracker.lastBytes;
          if (elapsedMs > 0 && bytesDelta > 0) {
            speedBytesPerSec = Math.round((bytesDelta / elapsedMs) * 1000);
          }
          tracker.lastBytes = sent;
          tracker.lastTime = now;
        } else {
          this.speedTrackers.set(id, { lastBytes: sent, lastTime: now });
        }
        void this.setState(transfer, { kind: "sending", percent, speedBytesPerSec });
      };

      if (transfer.direction === "download") {
        if (!this.writer) {
          throw new Error("TransferEngine has no writer configured for downloads");
        }
        await downloadTransfer(transfer, {
          client: this.client,
          bucket: this.bucket,
          writer: this.writer,
          onProgress,
          signal: controller.signal,
        });
      } else {
        await uploadTransfer(transfer, {
          client: this.client,
          bucket: this.bucket,
          reader: this.reader,
          onProgress,
          signal: controller.signal,
        });
      }

      await this.setState(transfer, { kind: "checking" });
      await this.setState(transfer, { kind: transfer.direction === "download" ? "downloaded" : "uploaded" });
      if (transfer.direction === "download") this.batchDownloaded += 1;
      else this.batchUploaded += 1;
    } catch (err) {
      if (this.cancelledIds.has(id)) {
        return;
      }
      const errorClass: ErrorClass =
        err instanceof VerificationError ? err.errorClass : classifyError(err);
      const current = this.transfers.get(id) ?? transfer;
      if (current.state.kind === "uploaded" || current.state.kind === "downloaded") return;
      log.error("transfer failed", current.key, errorClass, err instanceof Error ? err.message : "");
      try {
        await this.setState(current, { kind: "failed", errorClass });
      } catch {
        current.state = { kind: "failed", errorClass };
        current.updatedAt = this.now();
        await this.store.save(current);
        this.emit({ type: "transfer-updated", transfer: { ...current } });
      }
      this.batchFailed += 1;
    } finally {
      this.abortControllers.delete(id);
    }
  }
}
