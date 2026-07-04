// TransferEngine: drives the state machine
// queued → sending(percent) → checking → uploaded | failed
// with concurrency 3, persisting every state change and emitting
// EngineEvents to subscribers. Framework-free — no React, no Tauri.

import type { S3Client } from "@aws-sdk/client-s3";

import type {
  EngineEvent,
  ErrorClass,
  Transfer,
  TransferState,
  TransferStore,
} from "./types";
import { classifyError } from "./errors";
import {
  PART_SIZE,
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "./s3/multipart";

/** Valid next states for each current state — invalid transitions are rejected. */
export const STATE_TRANSITIONS: Record<
  TransferState["kind"],
  TransferState["kind"][]
> = {
  queued: ["sending", "failed"],
  sending: ["sending", "checking", "failed"],
  // "checking" -> "sending" covers resuming a transfer that was interrupted
  // mid-verification on a previous run; everything else about "checking" is terminal-ish.
  checking: ["uploaded", "failed", "sending"],
  uploaded: [],
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
const RESUMABLE_STATES: TransferState["kind"][] = ["queued", "sending", "checking"];

export interface EnqueueFile {
  localPath: string;
  size: number;
  /** Remote key this file uploads to. */
  key: string;
}

export interface TransferEngineDeps {
  client: S3Client;
  bucket: string;
  connectionId: string;
  reader: LocalFileReader;
  store: TransferStore;
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
  private readonly store: TransferStore;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly idGenerator: () => string;

  private readonly transfers = new Map<string, Transfer>();
  private readonly queue: string[] = [];
  private readonly active = new Set<string>();
  private readonly subscribers = new Set<(event: EngineEvent) => void>();
  private readonly acknowledged = new Set<string>();

  private batchUploaded = 0;
  private batchFailed = 0;
  private pumping = false;

  constructor(deps: TransferEngineDeps) {
    this.client = deps.client;
    this.bucket = deps.bucket;
    this.connectionId = deps.connectionId;
    this.reader = deps.reader;
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
    const created: Transfer[] = [];
    for (const file of files) {
      const t = this.now();
      const transfer: Transfer = {
        id: this.idGenerator(),
        connectionId: this.connectionId,
        key: file.key,
        localPath: file.localPath,
        size: file.size,
        partSize: PART_SIZE,
        state: { kind: "queued" },
        createdAt: t,
        updatedAt: t,
      };
      await this.store.save(transfer);
      this.transfers.set(transfer.id, transfer);
      this.queue.push(transfer.id);
      this.emit({ type: "transfer-updated", transfer: { ...transfer } });
      created.push(transfer);
    }
    void this.pump();
    return created;
  }

  /** Retry a failed transfer; multipart transfers resume from persisted parts. */
  async retry(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.state.kind !== "failed") return;
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
   * Reload transfers left mid-flight (queued/sending/checking) from the
   * store — called on app startup so an interrupted transfer resumes
   * instead of vanishing.
   */
  async resumePending(): Promise<void> {
    const all = await this.store.list(this.connectionId);
    for (const transfer of all) {
      this.transfers.set(transfer.id, transfer);
      if (RESUMABLE_STATES.includes(transfer.state.kind)) {
        if (!this.queue.includes(transfer.id) && !this.active.has(transfer.id)) {
          this.queue.push(transfer.id);
        }
      }
    }
    void this.pump();
  }

  private async setState(transfer: Transfer, next: TransferState): Promise<void> {
    if (!canTransition(transfer.state, next)) {
      throw new InvalidTransitionError(transfer.state, next);
    }
    transfer.state = next;
    transfer.updatedAt = this.now();
    await this.store.save(transfer);
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
        (this.batchUploaded > 0 || this.batchFailed > 0)) {
      this.emit({
        type: "batch-finished",
        uploaded: this.batchUploaded,
        failed: this.batchFailed,
      });
      this.batchUploaded = 0;
      this.batchFailed = 0;
    }
  }

  private async runTransfer(id: string): Promise<void> {
    const transfer = this.transfers.get(id) ?? (await this.store.get(id)) ?? undefined;
    if (!transfer) return;
    this.transfers.set(id, transfer);

    try {
      if (transfer.state.kind === "queued") {
        await this.setState(transfer, { kind: "sending", percent: 0 });
      } else if (transfer.state.kind !== "sending" && transfer.state.kind !== "checking") {
        // Nothing to do for uploaded/failed transfers pulled onto the queue.
        return;
      } else if (transfer.state.kind === "checking") {
        // Left mid-verification by a crash; re-run from sending(0) — the
        // upload step itself will fast-path already-uploaded parts.
        await this.setState(transfer, { kind: "sending", percent: 0 });
      }

      await uploadTransfer(transfer, {
        client: this.client,
        bucket: this.bucket,
        reader: this.reader,
        store: this.store,
        onProgress: (sent, total) => {
          const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 100;
          void this.setState(transfer, { kind: "sending", percent });
        },
      });

      await this.setState(transfer, { kind: "checking" });
      await this.setState(transfer, { kind: "uploaded" });
      this.batchUploaded += 1;
    } catch (err) {
      const errorClass: ErrorClass =
        err instanceof VerificationError ? err.errorClass : classifyError(err);
      // A transfer may be in "sending" or already "checking" when it fails.
      const current = this.transfers.get(id) ?? transfer;
      if (current.state.kind === "uploaded") return;
      try {
        await this.setState(current, { kind: "failed", errorClass });
      } catch {
        // If already failed/terminal for some reason, force-persist the class.
        current.state = { kind: "failed", errorClass };
        current.updatedAt = this.now();
        await this.store.save(current);
        this.emit({ type: "transfer-updated", transfer: { ...current } });
      }
      this.batchFailed += 1;
    }
  }
}
