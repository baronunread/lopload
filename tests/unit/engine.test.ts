import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import {
  STATE_TRANSITIONS,
  TransferEngine,
  canTransition,
} from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { md5Hex } from "../../src/lib/md5";
import type { EngineEvent, Transfer, TransferState } from "../../src/lib/types";
import type { LocalFileReader } from "../../src/lib/s3/multipart";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

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

function q(hex: string): string {
  return `"${hex}"`;
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
    expect(STATE_TRANSITIONS.sending).toEqual(["sending", "checking", "failed", "queued"]);
    expect(STATE_TRANSITIONS.checking).toEqual([
      "uploaded",
      "downloaded",
      "failed",
      "sending",
      "queued",
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

  test("sending and checking can re-queue (bounded auto-retry path)", () => {
    expect(canTransition({ kind: "sending", percent: 40 }, { kind: "queued" })).toBe(true);
    expect(canTransition({ kind: "checking" }, { kind: "queued" })).toBe(true);
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

describe("TransferEngine — single-part happy path", () => {
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

    // Never uploaded.
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

  test("retry resumes a failed transfer and can succeed the second time", async () => {
    const body = new TextEncoder().encode("retry me");
    const reader = makeReader({ "/local/d.txt": body });
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce({ name: "AccessDenied" })
      .resolves({ ETag: q(await md5Hex(body)) });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/d.txt", size: body.length, key: "d.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    await engine.retry(transfer.id);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "uploaded");

    expect(engine.getTransfer(transfer.id)!.state).toEqual({ kind: "uploaded" });
  });
});

describe("TransferEngine — bounded auto-retry", () => {
  const NETWORK_ERROR = { name: "ECONNRESET", message: "socket hang up" };

  test("transient network failure retries automatically and succeeds", async () => {
    const body = new TextEncoder().encode("flaky network");
    const reader = makeReader({ "/local/e.txt": body });
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce(NETWORK_ERROR)
      .rejectsOnce(NETWORK_ERROR)
      .resolves({ ETag: q(await md5Hex(body)) });

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      autoRetryDelaysMs: [1, 1, 1],
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueue([
      { localPath: "/local/e.txt", size: body.length, key: "e.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "uploaded");

    // Never surfaced as failed to subscribers — retried silently.
    const seenKinds = events
      .filter((e) => e.type === "transfer-updated")
      .map((e) => (e as { transfer: Transfer }).transfer.state.kind);
    expect(seenKinds).not.toContain("failed");

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 1, downloaded: 0, failed: 0 });
  });

  test("goes sticky-failed after exhausting the retry budget", async () => {
    const body = new TextEncoder().encode("always down");
    const reader = makeReader({ "/local/f.txt": body });
    s3Mock.on(PutObjectCommand).rejects(NETWORK_ERROR);

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      autoRetryDelaysMs: [1, 1, 1],
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/f.txt", size: body.length, key: "f.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    expect(engine.getTransfer(transfer.id)!.state).toEqual({
      kind: "failed",
      errorClass: "connection-dropped",
    });
    // 1 initial attempt + 3 retries.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(4);
  });

  test("non-retryable classes fail immediately, no auto-retry", async () => {
    const body = new TextEncoder().encode("wrong creds");
    const reader = makeReader({ "/local/g.txt": body });
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
      autoRetryDelaysMs: [1, 1, 1],
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/g.txt", size: body.length, key: "g.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  test("manual retry after sticky failure restores the auto-retry budget", async () => {
    const body = new TextEncoder().encode("second wind");
    const reader = makeReader({ "/local/h.txt": body });
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce(NETWORK_ERROR)
      .rejectsOnce(NETWORK_ERROR)
      .rejectsOnce(NETWORK_ERROR)
      .rejectsOnce(NETWORK_ERROR)
      .rejectsOnce(NETWORK_ERROR)
      .resolves({ ETag: q(await md5Hex(body)) });

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      autoRetryDelaysMs: [1, 1, 1],
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/h.txt", size: body.length, key: "h.txt" },
    ]);
    // Budget of 3 exhausted after 4 total attempts -> sticky failed.
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    // Manual retry: attempt 5 fails, attempt 6 succeeds via fresh auto-retry budget.
    await engine.retry(transfer.id);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "uploaded");

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(6);
  });

  test("cancel during backoff stops the scheduled retry", async () => {
    const body = new TextEncoder().encode("cancel me");
    const reader = makeReader({ "/local/i.txt": body });
    s3Mock.on(PutObjectCommand).rejects(NETWORK_ERROR);

    const store = new MemoryTransferStore();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      autoRetryDelaysMs: [50, 50, 50],
    });

    const [transfer] = await engine.enqueue([
      { localPath: "/local/i.txt", size: body.length, key: "i.txt" },
    ]);
    // Wait for the first failure to schedule its backoff (state back to queued).
    await waitUntil(() => s3Mock.commandCalls(PutObjectCommand).length === 1);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "queued");

    await engine.cancel(transfer.id);
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(engine.getTransfer(transfer.id)).toBeUndefined();
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
      const body = input.Body as Uint8Array;
      return { ETag: q(await md5Hex(body)) };
    });

    const store = new MemoryTransferStore();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      concurrency: 3,
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

describe("TransferEngine — resumePending", () => {
  test("non-terminal transfers are marked as failed, not auto-resumed", async () => {
    const store = new MemoryTransferStore();
    const now = Date.now();
    const sendingTransfer: Transfer = {
      id: "stuck-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 100,
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

    // Non-terminal transfers are now failed.
    const s1 = engine.getTransfer("stuck-1");
    expect(s1?.state.kind).toBe("failed");
    const s2 = engine.getTransfer("stuck-2");
    expect(s2?.state.kind).toBe("failed");

    // Terminal transfers keep their state.
    const d = engine.getTransfer("done-1");
    expect(d?.state.kind).toBe("uploaded");

    // Also persisted to store.
    expect((await store.get("stuck-1"))?.state.kind).toBe("failed");
    expect((await store.get("stuck-2"))?.state.kind).toBe("failed");

    // Nothing was re-queued — engine.queue is empty.
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
