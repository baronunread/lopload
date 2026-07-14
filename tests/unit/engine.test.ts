import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATE_TRANSITIONS,
  TransferEngine,
  canTransition,
} from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { EngineEvent, Transfer, TransferState, TransferTuning } from "../../src/lib/types";
import { DEFAULT_TUNING } from "../../src/lib/tuning";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/minio";
import { bucketProbe } from "../support/bucketProbe";
import { faultyFetch } from "../support/faultyFetch";
import { localFileReader, localFileWriter } from "../support/localFiles";
import { nativeFetch } from "../setup";

// A real, fresh bucket for the whole file — buckets (not container restarts)
// are the isolation unit, so every test in this file gets its own keys but
// shares one bucket and one warm MinIO.
let bucket: Bucket;
let workdir: string;

beforeAll(async () => {
  bucket = await freshBucket();
  workdir = await mkdtemp(join(tmpdir(), "lopload-engine-test-"));
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Wraps a FetchFn so requests matching a key (and method) never resolve —
 * the real-storage equivalent of the old mock's `() => new Promise(() => {})`,
 * for tests that need a transfer parked mid-flight indefinitely. There's no
 * `Fault` for this (faultyFetch's `stall` always eventually completes), so
 * it's implemented locally rather than in tests/support. */
function hangOn(inner: FetchFn, keys: string[], method = "PUT"): FetchFn {
  return async (input, init) => {
    const url = urlOf(input);
    const m = (init?.method ?? "GET").toUpperCase();
    if (m === method.toUpperCase() && keys.some((k) => url.includes(k))) {
      return new Promise<Response>(() => {});
    }
    return inner(input, init);
  };
}

async function writeLocalFile(name: string, body: Uint8Array): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, body);
  return path;
}

const ALL_STATES: TransferState["kind"][] = [
  "queued",
  "sending",
  "checking",
  "uploaded",
  "downloaded",
  "failed",
];

describe("state machine transition table", () => {
  test("valid transitions per PLAN.md", () => {
    expect(STATE_TRANSITIONS.queued).toEqual(["sending", "failed"]);
    expect(STATE_TRANSITIONS.sending).toEqual(["sending", "checking", "failed"]);
    expect(STATE_TRANSITIONS.checking).toEqual([
      "uploaded",
      "downloaded",
      "failed",
    ]);
    expect(STATE_TRANSITIONS.uploaded).toEqual([]);
    expect(STATE_TRANSITIONS.downloaded).toEqual([]);
    expect(STATE_TRANSITIONS.failed).toEqual(["queued"]);
  });

  test("uploaded is terminal — no transition out is valid", () => {
    for (const kind of ALL_STATES) {
      expect(canTransition({ kind: "uploaded" }, stateOf(kind))).toBe(false);
    }
  });

  test("downloaded is terminal — no transition out is valid", () => {
    for (const kind of ALL_STATES) {
      expect(canTransition({ kind: "downloaded" }, stateOf(kind))).toBe(false);
    }
  });

  test("cannot jump straight from queued to uploaded or checking", () => {
    expect(canTransition({ kind: "queued" }, { kind: "uploaded" })).toBe(false);
    expect(canTransition({ kind: "queued" }, { kind: "checking" })).toBe(false);
  });

  test("sending and checking can no longer re-queue (no auto-retry)", () => {
    expect(canTransition({ kind: "sending", percent: 40 }, { kind: "queued" })).toBe(false);
    expect(canTransition({ kind: "checking" }, { kind: "queued" })).toBe(false);
  });

  test("failed only ever transitions back to queued (retry)", () => {
    expect(canTransition({ kind: "failed", errorClass: "unknown" }, { kind: "queued" })).toBe(
      true,
    );
    expect(
      canTransition({ kind: "failed", errorClass: "unknown" }, { kind: "uploaded" }),
    ).toBe(false);
    expect(
      canTransition({ kind: "failed", errorClass: "unknown" }, { kind: "sending", percent: 0 }),
    ).toBe(false);
  });

  function stateOf(kind: TransferState["kind"]): TransferState {
    switch (kind) {
      case "sending":
        return { kind: "sending", percent: 0 };
      case "failed":
        return { kind: "failed", errorClass: "unknown" };
      default:
        return { kind } as TransferState;
    }
  }
});

describe("TransferEngine — single-part upload", () => {
  test("queued -> sending -> checking -> uploaded, persisted at every step", async () => {
    const body = new TextEncoder().encode("small file");
    const path = await writeLocalFile("a.txt", body);
    const client = clientWith();

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueue([
      { localPath: path, size: body.length, key: "a.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "uploaded");

    const finalTransfer = engine.getTransfer(transfer.id)!;
    expect(finalTransfer.state).toEqual({ kind: "uploaded" });

    const persisted = await store.get(transfer.id);
    expect(persisted?.state).toEqual({ kind: "uploaded" });

    const seenKinds = events
      .filter((e) => e.type === "transfer-updated")
      .map((e) => (e as { transfer: Transfer }).transfer.state.kind);
    expect(seenKinds[0]).toBe("queued");
    expect(seenKinds).toContain("sending");
    expect(seenKinds).toContain("checking");
    expect(seenKinds[seenKinds.length - 1]).toBe("uploaded");

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 1, downloaded: 0, failed: 0 });

    const probe = bucketProbe(bucket.client, bucket.name);
    expect(await probe.get("a.txt")).toEqual(body);
  });

  test("ETag mismatch -> failed with errorClass verification, sticky", async () => {
    const body = new TextEncoder().encode("mismatched");
    const path = await writeLocalFile("b.txt", body);
    const client = clientWith(
      faultyFetch(nativeFetch, [
        { urlContains: "b.txt", method: "PUT", action: { kind: "corruptEtag" } },
      ]),
    );

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: path, size: body.length, key: "b.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    const finalTransfer = engine.getTransfer(transfer.id)!;
    expect(finalTransfer.state).toEqual({ kind: "failed", errorClass: "verification" });

    expect(finalTransfer.state.kind).not.toBe("uploaded");
  });

  test("credentials error (403) maps through to errorClass credentials", async () => {
    const body = new TextEncoder().encode("x");
    const path = await writeLocalFile("c.txt", body);
    const client = clientWith(
      faultyFetch(nativeFetch, [
        {
          urlContains: "c.txt",
          method: "PUT",
          action: { kind: "s3Error", status: 403, code: "AccessDenied", message: "Access Denied" },
        },
      ]),
    );

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: path, size: body.length, key: "c.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");
    expect(engine.getTransfer(transfer.id)!.state).toEqual({
      kind: "failed",
      errorClass: "credentials",
    });
  });
});

describe("TransferEngine — concurrency and batching", () => {
  test("processes an enqueued batch and emits one batch-finished with correct counts", async () => {
    const specs = await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        const body = new TextEncoder().encode(`file-${n}`);
        const path = await writeLocalFile(`f${n}.txt`, body);
        return { localPath: path, size: body.length, key: `f${n}.txt` };
      }),
    );

    const client = clientWith();
    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 3 }),
    });
    engine.subscribe((e) => events.push(e));

    const transfers = await engine.enqueue(specs);
    await waitUntil(() =>
      transfers.every((t) => engine.getTransfer(t.id)?.state.kind === "uploaded"),
    );

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 5, downloaded: 0, failed: 0 });
  });
});

describe("TransferEngine — live tuning", () => {
  test("raising concurrentFiles mid-batch admits more transfers on the next pump", async () => {
    const keys = ["1.txt", "2.txt", "3.txt", "4.txt"];
    const client = clientWith(hangOn(nativeFetch, keys)); // every PUT hangs forever
    const paths = await Promise.all(
      keys.map((k, i) => writeLocalFile(k, new Uint8Array([i + 1]))),
    );
    const store = new MemoryTransferStore();
    let currentTuning: TransferTuning = { ...DEFAULT_TUNING, concurrentFiles: 1 };
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => currentTuning,
    });

    await engine.enqueue([
      { localPath: paths[0], size: 1, key: keys[0] },
      { localPath: paths[1], size: 1, key: keys[1] },
      { localPath: paths[2], size: 1, key: keys[2] },
    ]);

    await waitUntil(() => engine["active"].size === 1);
    expect(engine["queue"].length).toBe(2);

    // Raising the live tuning alone doesn't retrigger a pump — the next
    // enqueue does, which is exactly the "no restart needed" contract.
    currentTuning = { ...currentTuning, concurrentFiles: 3 };
    await engine.enqueue([{ localPath: paths[3], size: 1, key: keys[3] }]);

    await waitUntil(() => engine["active"].size === 3);
    expect(engine["queue"].length).toBe(1);
  });

  test("enqueue captures partSize from tuning's partSizeMiB at enqueue time", async () => {
    const path = await writeLocalFile("x.bin", new Uint8Array(0));
    const client = clientWith();
    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, partSizeMiB: 32 }),
    });

    const [transfer] = await engine.enqueue([
      { localPath: path, size: 0, key: "x.bin" },
    ]);

    expect(transfer.partSize).toBe(32 * 1024 * 1024);
  });
});

describe("TransferEngine — resumePending", () => {
  test("non-terminal transfers are silently cleaned up, not surfaced as failed", async () => {
    const store = new MemoryTransferStore();
    const now = Date.now();
    const sendingTransfer: Transfer = {
      id: "stuck-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "sending", percent: 33 },
      createdAt: now,
      updatedAt: now,
    };
    const queuedTransfer: Transfer = {
      id: "stuck-2",
      connectionId: "conn-1",
      key: "other.bin",
      localPath: "/local/other.bin",
      size: 50,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "queued" },
      createdAt: now,
      updatedAt: now,
    };
    const doneTransfer: Transfer = {
      id: "done-1",
      connectionId: "conn-1",
      key: "done.bin",
      localPath: "/local/done.bin",
      size: 10,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "uploaded" },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(sendingTransfer);
    await store.save(queuedTransfer);
    await store.save(doneTransfer);

    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });

    await engine.resumePending();

    expect(engine.getTransfer("stuck-1")).toBeUndefined();
    expect(engine.getTransfer("stuck-2")).toBeUndefined();
    expect(await store.get("stuck-1")).toBeNull();
    expect(await store.get("stuck-2")).toBeNull();

    const d = engine.getTransfer("done-1");
    expect(d?.state.kind).toBe("uploaded");

    expect(engine["queue"]).toEqual([]);
  });

  test("an upload with a persisted uploadId is re-queued instead of dropped", async () => {
    const store = new MemoryTransferStore();
    const now = Date.now();
    const resumable: Transfer = {
      id: "resumable-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
      partSize: 8 * 1024 * 1024,
      uploadId: "upload-abc",
      direction: "upload",
      state: { kind: "sending", percent: 40 },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(resumable);

    const events: EngineEvent[] = [];
    // concurrentFiles: 0 keeps pump() from immediately dequeuing the item
    // into "sending" so the re-queue itself is observable.
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 0 }),
    });
    engine.subscribe((e) => events.push(e));

    await engine.resumePending();

    const resumed = engine.getTransfer("resumable-1");
    expect(resumed?.state).toEqual({ kind: "queued" });
    expect(resumed?.uploadId).toBe("upload-abc");
    expect(engine["queue"]).toContain("resumable-1");

    const persisted = await store.get("resumable-1");
    expect(persisted?.state).toEqual({ kind: "queued" });
    expect(persisted?.uploadId).toBe("upload-abc");

    const updateEvents = events.filter(
      (e) => e.type === "transfer-updated" && e.transfer.id === "resumable-1",
    );
    expect(updateEvents.length).toBeGreaterThan(0);
  });

  test("an upload without a persisted uploadId is still dropped (unchanged behavior)", async () => {
    const store = new MemoryTransferStore();
    const now = Date.now();
    const noUploadId: Transfer = {
      id: "no-upload-id-1",
      connectionId: "conn-1",
      key: "small.bin",
      localPath: "/local/small.bin",
      size: 10,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "checking" },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(noUploadId);

    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 0 }),
    });

    await engine.resumePending();

    expect(engine.getTransfer("no-upload-id-1")).toBeUndefined();
    expect(await store.get("no-upload-id-1")).toBeNull();
    expect(engine["queue"]).toEqual([]);
  });

  test("a non-terminal download is dropped, never re-queued (downloads resume from local temp-file state, not an engine-tracked id)", async () => {
    const store = new MemoryTransferStore();
    const now = Date.now();
    const download: Transfer = {
      id: "download-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
      partSize: 8 * 1024 * 1024,
      direction: "download",
      state: { kind: "sending", percent: 60 },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(download);

    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 0 }),
    });

    await engine.resumePending();

    expect(engine.getTransfer("download-1")).toBeUndefined();
    expect(await store.get("download-1")).toBeNull();
    expect(engine["queue"]).toEqual([]);
  });

  test("calling resumePending twice sequentially never double-queues a resumable upload", async () => {
    const store = new CountingTransferStore();
    const now = Date.now();
    const resumable: Transfer = {
      id: "resumable-seq-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
      partSize: 8 * 1024 * 1024,
      uploadId: "upload-abc",
      direction: "upload",
      state: { kind: "sending", percent: 40 },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(resumable);

    // concurrentFiles: 0 keeps pump() from dequeuing the item so we can
    // observe the queue contents directly.
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 0 }),
    });

    await engine.resumePending();
    await engine.resumePending();

    const queue = engine["queue"] as string[];
    expect(queue.filter((id) => id === "resumable-seq-1")).toHaveLength(1);
    expect(store.listCallCount).toBe(2);
  });

  test("calling resumePending concurrently (Promise.all) never double-queues a resumable upload", async () => {
    const store = new CountingTransferStore();
    const now = Date.now();
    const resumable: Transfer = {
      id: "resumable-conc-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
      partSize: 8 * 1024 * 1024,
      uploadId: "upload-def",
      direction: "upload",
      state: { kind: "sending", percent: 40 },
      createdAt: now,
      updatedAt: now,
    };
    await store.save(resumable);

    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 0 }),
    });

    await Promise.all([engine.resumePending(), engine.resumePending()]);

    const queue = engine["queue"] as string[];
    expect(queue.filter((id) => id === "resumable-conc-1")).toHaveLength(1);
    expect(engine["active"].has("resumable-conc-1")).toBe(false);
  });
});

/** A MemoryTransferStore that counts list() calls, for asserting a
 * resumePending call actually re-read the store rather than merely
 * verifying its guard short-circuits — the guard itself is what's
 * under test, so the store must be exercised on every call. */
class CountingTransferStore extends MemoryTransferStore {
  listCallCount = 0;

  override async list(connectionId: string): Promise<Transfer[]> {
    this.listCallCount++;
    return super.list(connectionId);
  }
}

describe("TransferEngine — progress throttling (updateProgress vs persistState)", () => {
  test("500 progress ticks trigger no additional store.save calls beyond the real state transitions", async () => {
    // Every PUT hangs forever so the transfer stays parked in "sending" —
    // we can then hammer the progress path directly without racing the
    // real upload to completion.
    const client = clientWith(hangOn(nativeFetch, ["big-upload.bin"]));

    let saveCount = 0;
    class CountingStore extends MemoryTransferStore {
      override async save(t: Transfer): Promise<void> {
        saveCount += 1;
        return super.save(t);
      }
    }
    const store = new CountingStore();
    const path = await writeLocalFile("big-upload.bin", new Uint8Array(10));
    const engine = new TransferEngine({
      client,
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: path, size: 10, key: "big-upload.bin" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "sending");

    // enqueue's initial save + the queued->sending transition save.
    const savesBeforeProgress = saveCount;
    expect(savesBeforeProgress).toBeLessThanOrEqual(5);

    const live = engine.getTransfer(transfer.id)!;
    const tracker = { lastEmitTime: 0 };
    for (let i = 1; i <= 500; i++) {
      (engine as unknown as {
        updateProgress: (
          t: Transfer,
          percent: number,
          speed: number | undefined,
          tr: { lastEmitTime: number },
        ) => void;
      }).updateProgress(live, Math.min(100, Math.round((i / 500) * 100)), undefined, tracker);
    }

    // Progress ticks must never call store.save — SqliteTransferStore.save
    // only persists state.kind, never percent, so persisting on every tick
    // would be pure write amplification for zero benefit.
    expect(saveCount).toBe(savesBeforeProgress);
  });

  test("transfer-updated emits during progress are throttled to ~200ms per transfer", () => {
    let fakeNow = 1_000_000;
    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
      now: () => fakeNow,
    });
    engine.subscribe((e) => events.push(e));

    const transfer: Transfer = {
      id: "t-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 1000,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "sending", percent: 0 },
      createdAt: fakeNow,
      updatedAt: fakeNow,
    };
    const tracker = { lastEmitTime: fakeNow };

    const updateProgress = (
      engine as unknown as {
        updateProgress: (
          t: Transfer,
          percent: number,
          speed: number | undefined,
          tr: { lastEmitTime: number },
        ) => void;
      }
    ).updateProgress.bind(engine);

    // 500 ticks, 10ms apart in fake time (5000ms total) — at a 200ms
    // throttle that's at most ~26 emits, not 500.
    for (let i = 1; i <= 500; i++) {
      fakeNow += 10;
      const percent = i === 500 ? 100 : Math.min(99, Math.round((i / 500) * 100));
      updateProgress(transfer, percent, undefined, tracker);
    }

    const progressEmits = events.filter(
      (e) => e.type === "transfer-updated" && e.transfer.state.kind === "sending",
    );
    expect(progressEmits.length).toBeGreaterThan(0);
    expect(progressEmits.length).toBeLessThan(50);

    // The final 100% tick must always emit immediately, regardless of the
    // throttle window, so the UI never sticks at 99%.
    const last = progressEmits[progressEmits.length - 1] as { transfer: Transfer };
    expect(last.transfer.state).toEqual({ kind: "sending", percent: 100, speedBytesPerSec: undefined });
  });

  test("updateProgress never resurrects a cancelled transfer", () => {
    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const transfer: Transfer = {
      id: "cancelled-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 1000,
      partSize: 8 * 1024 * 1024,
      direction: "upload",
      state: { kind: "sending", percent: 10 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    (engine as unknown as { cancelledIds: Set<string> }).cancelledIds.add(transfer.id);

    const tracker = { lastEmitTime: 0 };
    (
      engine as unknown as {
        updateProgress: (
          t: Transfer,
          percent: number,
          speed: number | undefined,
          tr: { lastEmitTime: number },
        ) => void;
      }
    ).updateProgress(transfer, 50, undefined, tracker);

    expect(engine.getTransfer(transfer.id)).toBeUndefined();
    expect(events.filter((e) => e.type === "transfer-updated")).toEqual([]);
  });
});

describe("TransferEngine — progress wiring end-to-end", () => {
  test("a download that ticks onProgress hundreds of times still ends with few store.save calls and a bounded number of emits", async () => {
    const body = new Uint8Array(500).map((_, i) => i % 256);
    const probe = bucketProbe(bucket.client, bucket.name);
    await probe.put("big-download.bin", body);

    let saveCount = 0;
    class CountingStore extends MemoryTransferStore {
      override async save(t: Transfer): Promise<void> {
        saveCount += 1;
        return super.save(t);
      }
    }
    const store = new CountingStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client: clientWith(),
      bucket: bucket.name,
      connectionId: "conn-1",
      reader: localFileReader,
      writer: localFileWriter,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const localPath = join(workdir, "big-download.bin");
    const [transfer] = await engine.enqueueDownloads([
      { key: "big-download.bin", localPath, size: body.length },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "downloaded");

    const progressEmits = events.filter(
      (e) => e.type === "transfer-updated" && e.transfer.state.kind === "sending",
    );
    // A real streamed response doesn't dribble in one byte at a time the way
    // the old mock did, so this is a looser bound than "under 500" — the
    // throttle contract under test is the ceiling, not the exact chunking.
    expect(progressEmits.length).toBeLessThan(500);
    // save() is only ever called for real transitions (queued->sending,
    // sending->checking, checking->downloaded), never per progress tick.
    expect(saveCount).toBeLessThanOrEqual(5);

    const committed = await Bun.file(localPath).arrayBuffer();
    expect(new Uint8Array(committed)).toEqual(body);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
