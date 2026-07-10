import type { S3Client } from "@aws-sdk/client-s3";

import type {
  EngineEvent,
  ErrorClass,
  Transfer,
  TransferState,
  TransferStore,
  TransferTuning,
} from "./types";
import { createLogger } from "./logger";
import { classifyError, describeThrown } from "./errors";
import { DEFAULT_TUNING } from "./tuning";

const log = createLogger("engine");
import {
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "./s3/multipart";
import { downloadTransfer, type LocalFileWriter } from "./s3/download";

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

export interface EnqueueFile {
  localPath: string;
  size: number;
  key: string;
  folderId?: string;
  folderName?: string;
}

export interface TransferEngineDeps {
  client: S3Client;
  bucket: string;
  connectionId: string;
  reader: LocalFileReader;
  store: TransferStore;
  writer?: LocalFileWriter;
  /** Read live on every pump() loop and enqueue — no need to recreate the
   * engine when the user changes transfer speed settings. Defaults to
   * DEFAULT_TUNING (Normal). */
  tuning?: () => TransferTuning;
  now?: () => number;
  idGenerator?: () => string;
}

export class TransferEngine {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly connectionId: string;
  private readonly reader: LocalFileReader;
  private readonly writer?: LocalFileWriter;
  private readonly store: TransferStore;
  private readonly tuning: () => TransferTuning;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  private readonly transfers = new Map<string, Transfer>();
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private readonly subscribers = new Set<(event: EngineEvent) => void>();
  private readonly acknowledged = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cancelledIds = new Set<string>();
  private readonly speedTrackers = new Map<string, {
    samples: { bytes: number; time: number }[];
    lastDisplayedSpeed?: number;
    lastDisplayTime: number;
    lastEmitTime: number;
  }>();

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
    this.tuning = deps.tuning ?? (() => DEFAULT_TUNING);
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

  async enqueue(files: EnqueueFile[]): Promise<Transfer[]> {
    return this.enqueueInternal(files, "upload");
  }

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
        partSize: this.tuning().partSizeMiB * 1024 * 1024,
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

  acknowledge(transferId: string): void {
    this.acknowledged.add(transferId);
  }

  async dismiss(transferId: string): Promise<void> {
    this.transfers.delete(transferId);
    this.acknowledged.delete(transferId);
    await this.store.delete(transferId);
  }

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

  private resumePendingPromise: Promise<void> | null = null;

  /** Idempotent and safe to call concurrently: a second call that overlaps
   * with an in-flight one simply awaits the same in-flight work rather than
   * re-reading the store and racing to re-queue the same transfers (the
   * per-transfer queue/active checks below only protect against *sequential*
   * repeat calls, since two truly concurrent calls would both pass those
   * checks before either had a chance to push to the queue). */
  async resumePending(): Promise<void> {
    if (!this.resumePendingPromise) {
      this.resumePendingPromise = this.resumePendingInternal().finally(() => {
        this.resumePendingPromise = null;
      });
    }
    return this.resumePendingPromise;
  }

  private async resumePendingInternal(): Promise<void> {
    const all = await this.store.list(this.connectionId);
    for (const transfer of all) {
      // Idempotency guard: if this transfer id is already queued, actively
      // running, or already tracked in a non-terminal state, a previous
      // (possibly concurrent) call to resumePending already handled it —
      // skip it so we never double-queue the same upload.
      if (this.queue.includes(transfer.id) || this.active.has(transfer.id)) {
        continue;
      }
      const tracked = this.transfers.get(transfer.id);
      if (
        tracked &&
        (tracked.state.kind === "queued" ||
          tracked.state.kind === "sending" ||
          tracked.state.kind === "checking")
      ) {
        continue;
      }
      if (
        transfer.state.kind === "queued" ||
        transfer.state.kind === "sending" ||
        transfer.state.kind === "checking"
      ) {
        // An upload with a persisted uploadId can pick up where it left off
        // — uploadMultipart's ListParts reconciliation skips whatever parts
        // already made it to S3. Everything else (uploads that never got an
        // uploadId, and downloads, which resume from local temp-file state
        // rather than any engine-tracked id) keeps the previous behavior of
        // being dropped rather than silently surfaced as failed.
        if (transfer.direction === "upload" && transfer.uploadId) {
          transfer.state = { kind: "queued" };
          transfer.updatedAt = this.now();
          await this.store.save(transfer);
          this.transfers.set(transfer.id, transfer);
          this.queue.push(transfer.id);
          this.emit({ type: "transfer-updated", transfer: { ...transfer } });
          continue;
        }
        await this.store.delete(transfer.id);
        continue;
      }
      this.transfers.set(transfer.id, transfer);
    }
    void this.pump();
  }

  /**
   * Real state-machine transitions (queued -> sending -> checking -> ...).
   * Validates via canTransition, persists to the store, and emits.
   */
  private async persistState(transfer: Transfer, next: TransferState): Promise<void> {
    if (!canTransition(transfer.state, next)) {
      log.warn("invalid transition", transfer.id, transfer.state.kind, "->", next.kind);
      throw new InvalidTransitionError(transfer.state, next);
    }
    transfer.state = next;
    transfer.updatedAt = this.now();
    await this.store.save(transfer);
    if (this.cancelledIds.has(transfer.id)) return;
    this.transfers.set(transfer.id, transfer);
    this.emit({ type: "transfer-updated", transfer: { ...transfer } });
  }

  /**
   * In-progress percent/speed ticks within the "sending" state. Streamed
   * transfers can call this once per ~64 KiB chunk, so unlike persistState
   * this never touches the store (SqliteTransferStore.save only persists
   * transfer.state.kind, never percent — a progress write is pure waste)
   * and throttles transfer-updated emits to at most once per ~200ms per
   * transfer, always emitting immediately at 100% so the UI doesn't stick.
   * Synchronous — no awaits — so it can't build an unbounded backlog of
   * promises on the hot path the way `void this.setState(...)` used to.
   */
  private updateProgress(
    transfer: Transfer,
    percent: number,
    speedBytesPerSec: number | undefined,
    tracker: { lastEmitTime: number },
  ): void {
    if (this.cancelledIds.has(transfer.id)) return;
    transfer.state = { kind: "sending", percent, speedBytesPerSec };
    transfer.updatedAt = this.now();
    this.transfers.set(transfer.id, transfer);
    const now = this.now();
    if (percent >= 100 || now - tracker.lastEmitTime >= 200) {
      tracker.lastEmitTime = now;
      this.emit({ type: "transfer-updated", transfer: { ...transfer } });
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.active.size < this.tuning().concurrentFiles) {
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
        await this.persistState(transfer, { kind: "sending", percent: 0 });
      } else if (transfer.state.kind !== "sending" && transfer.state.kind !== "checking") {
        return;
      } else if (transfer.state.kind === "checking") {
        await this.persistState(transfer, { kind: "sending", percent: 0 });
      }

      const onProgress = (sent: number, total: number) => {
        const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 100;
        const now = this.now();
        let tracker = this.speedTrackers.get(id);
        if (!tracker) {
          tracker = {
            samples: [],
            lastDisplayedSpeed: undefined,
            lastDisplayTime: 0,
            lastEmitTime: 0,
          };
          this.speedTrackers.set(id, tracker);
        }
        tracker.samples.push({ bytes: sent, time: now });
        while (tracker.samples.length > 2 && now - tracker.samples[1].time > 5000) {
          tracker.samples.shift();
        }
        if (now - tracker.lastDisplayTime >= 750) {
          const first = tracker.samples[0];
          const elapsedMs = now - first.time;
          const bytesDelta = sent - first.bytes;
          if (elapsedMs >= 500 && bytesDelta > 0) {
            const computed = (bytesDelta / elapsedMs) * 1000;
            tracker.lastDisplayedSpeed = Math.round(
              tracker.lastDisplayedSpeed === undefined
                ? computed
                : tracker.lastDisplayedSpeed * 0.6 + computed * 0.4,
            );
            tracker.lastDisplayTime = now;
          }
        }
        this.updateProgress(transfer, percent, tracker.lastDisplayedSpeed, tracker);
      };

      if (transfer.direction === "download") {
        if (!this.writer) {
          throw new Error("TransferEngine has no writer configured for downloads");
        }
        await downloadTransfer(transfer, {
          client: this.client,
          bucket: this.bucket,
          writer: this.writer,
          reader: this.reader,
          store: this.store,
          connections: this.tuning().downloadConnections,
          onProgress,
          signal: controller.signal,
        });
      } else {
        await uploadTransfer(transfer, {
          client: this.client,
          bucket: this.bucket,
          reader: this.reader,
          store: this.store,
          onProgress,
          signal: controller.signal,
          partsInFlight: this.tuning().uploadPartsInFlight,
        });
      }

      await this.persistState(transfer, { kind: "checking" });
      await this.persistState(transfer, { kind: transfer.direction === "download" ? "downloaded" : "uploaded" });
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
      log.error("transfer failed", current.key, errorClass, describeThrown(err));
      try {
        await this.persistState(current, { kind: "failed", errorClass });
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