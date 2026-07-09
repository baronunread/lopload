import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  STATE_TRANSITIONS,
  TransferEngine,
  canTransition,
} from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { md5Hex } from "../../src/lib/md5";
import type { EngineEvent, Transfer, TransferState, TransferTuning } from "../../src/lib/types";
import { DEFAULT_TUNING } from "../../src/lib/tuning";
import type { LocalFileReader } from "../../src/lib/s3/multipart";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

function q(hex: string): string {
  return `"${hex}"`;
}

beforeEach(() => {
  s3Mock.reset();
});

function makeReader(files: Record<string, Uint8Array>): LocalFileReader {
  return {
    async size(path) {
      return files[path]?.length ?? 0;
    },
    async readChunk(path, offset, length) {
      const bytes = files[path] ?? new Uint8Array(0);
      return bytes.slice(offset, offset + length);
    },
  };
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
    const reader = makeReader({ "/local/a.txt": body });
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(await md5Hex(body)) });

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueue([
      { localPath: "/local/a.txt", size: body.length, key: "a.txt" },
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
  });

  test("ETag mismatch -> failed with errorClass verification, sticky", async () => {
    const body = new TextEncoder().encode("mismatched");
    const reader = makeReader({ "/local/b.txt": body });
    s3Mock.on(PutObjectCommand).resolves({ ETag: q("f".repeat(32)) });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/b.txt", size: body.length, key: "b.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    const finalTransfer = engine.getTransfer(transfer.id)!;
    expect(finalTransfer.state).toEqual({ kind: "failed", errorClass: "verification" });

    expect(finalTransfer.state.kind).not.toBe("uploaded");
  });

  test("credentials error (403) maps through to errorClass credentials", async () => {
    const body = new TextEncoder().encode("x");
    const reader = makeReader({ "/local/c.txt": body });
    s3Mock.on(PutObjectCommand).rejects({
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/c.txt", size: body.length, key: "c.txt" },
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
    const files: Record<string, Uint8Array> = {};
    const specs = [1, 2, 3, 4, 5].map((n) => {
      const path = `/local/f${n}.txt`;
      const body = new TextEncoder().encode(`file-${n}`);
      files[path] = body;
      return { localPath: path, size: body.length, key: `f${n}.txt` };
    });
    const reader = makeReader(files);

    s3Mock.on(PutObjectCommand).callsFake(async (input) => {
      const bodyBytes = input.Body instanceof Uint8Array ? input.Body : new Uint8Array(0);
      return { ETag: q(await md5Hex(bodyBytes)) };
    });

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
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
    s3Mock.on(PutObjectCommand).callsFake(() => new Promise(() => {})); // hangs forever
    const reader = makeReader({
      "/local/1.txt": new Uint8Array([1]),
      "/local/2.txt": new Uint8Array([2]),
      "/local/3.txt": new Uint8Array([3]),
      "/local/4.txt": new Uint8Array([4]),
    });
    const store = new MemoryTransferStore();
    let currentTuning: TransferTuning = { ...DEFAULT_TUNING, concurrentFiles: 1 };
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      tuning: () => currentTuning,
    });

    await engine.enqueue([
      { localPath: "/local/1.txt", size: 1, key: "1.txt" },
      { localPath: "/local/2.txt", size: 1, key: "2.txt" },
      { localPath: "/local/3.txt", size: 1, key: "3.txt" },
    ]);

    await waitUntil(() => engine["active"].size === 1);
    expect(engine["queue"].length).toBe(2);

    // Raising the live tuning alone doesn't retrigger a pump — the next
    // enqueue does, which is exactly the "no restart needed" contract.
    currentTuning = { ...currentTuning, concurrentFiles: 3 };
    await engine.enqueue([{ localPath: "/local/4.txt", size: 1, key: "4.txt" }]);

    await waitUntil(() => engine["active"].size === 3);
    expect(engine["queue"].length).toBe(1);
  });

  test("enqueue captures partSize from tuning's partSizeMiB at enqueue time", async () => {
    const reader = makeReader({});
    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      tuning: () => ({ ...DEFAULT_TUNING, partSizeMiB: 32 }),
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/x.bin", size: 0, key: "x.bin" },
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
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
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
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
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
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
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
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      store,
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 0 }),
    });

    await engine.resumePending();

    expect(engine.getTransfer("download-1")).toBeUndefined();
    expect(await store.get("download-1")).toBeNull();
    expect(engine["queue"]).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}