import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { TransferEngine } from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { md5Hex } from "../../src/lib/md5";
import type { LocalFileWriter } from "../../src/lib/s3/download";
import type { LocalFileReader } from "../../src/lib/s3/multipart";
import type { EngineEvent } from "../../src/lib/types";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

beforeEach(() => {
  s3Mock.reset();
});

function q(hex: string): string {
  return `"${hex}"`;
}

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

/** In-memory fake writer, so download tests never touch a real filesystem. */
function makeWriter() {
  const committed = new Map<string, Uint8Array>();
  const discarded: string[] = [];
  const staging = new Map<string, Uint8Array[]>();

  const writer: LocalFileWriter = {
    tempPathFor(finalPath) {
      return `${finalPath}.tmp`;
    },
    async writeChunk(tempPath, chunk, isFirst) {
      if (isFirst || !staging.has(tempPath)) staging.set(tempPath, []);
      staging.get(tempPath)!.push(chunk);
    },
    async commit(tempPath, finalPath) {
      const chunks = staging.get(tempPath) ?? [];
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      committed.set(finalPath, out);
      staging.delete(tempPath);
    },
    async discard(tempPath) {
      discarded.push(tempPath);
      staging.delete(tempPath);
    },
  };

  return { writer, committed, discarded };
}

function bodyStreamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("TransferEngine — download state machine", () => {
  test("queued -> sending -> checking -> downloaded, verified and committed", async () => {
    const body = new TextEncoder().encode("remote file contents");
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q(md5Hex(body)),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const { writer, committed } = makeWriter();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueueDownloads([
      { key: "remote/a.txt", localPath: "/local/a.txt", size: body.length },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "downloaded");

    expect(committed.get("/local/a.txt")).toEqual(body);
    const persisted = await store.get(transfer.id);
    expect(persisted?.state).toEqual({ kind: "downloaded" });
    expect(persisted?.direction).toBe("download");

    const seenKinds = events
      .filter((e) => e.type === "transfer-updated")
      .map((e) => (e as { transfer: { state: { kind: string } } }).transfer.state.kind);
    expect(seenKinds[0]).toBe("queued");
    expect(seenKinds).toContain("sending");
    expect(seenKinds).toContain("checking");
    expect(seenKinds[seenKinds.length - 1]).toBe("downloaded");

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 0, downloaded: 1, failed: 0 });
  });

  test("checksum mismatch -> failed with errorClass verification, sticky", async () => {
    const body = new TextEncoder().encode("remote file contents");
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q("f".repeat(32)),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const { writer, committed } = makeWriter();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });

    const [transfer] = await engine.enqueueDownloads([
      { key: "remote/b.txt", localPath: "/local/b.txt", size: body.length },
    ]);

    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");
    expect(engine.getTransfer(transfer.id)!.state).toEqual({
      kind: "failed",
      errorClass: "verification",
    });
    expect(committed.size).toBe(0);

    // Retry restarts the same download from scratch — no partial-resume for GET.
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q(md5Hex(body)),
      ContentLength: body.length,
    });
    await engine.retry(transfer.id);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "downloaded");
    expect(committed.get("/local/b.txt")).toEqual(body);
  });

  test("mixed upload+download batch reports both counts on batch-finished", async () => {
    const uploadBody = new TextEncoder().encode("upload me");
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(md5Hex(uploadBody)) });
    const downloadBody = new TextEncoder().encode("download me");
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(downloadBody) as never,
      ETag: q(md5Hex(downloadBody)),
      ContentLength: downloadBody.length,
    });

    const store = new MemoryTransferStore();
    const { writer } = makeWriter();
    const reader = makeReader({ "/local/up.txt": uploadBody });
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      writer,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [upTransfer] = await engine.enqueue([
      { localPath: "/local/up.txt", size: uploadBody.length, key: "up.txt" },
    ]);
    const [downTransfer] = await engine.enqueueDownloads([
      { key: "down.txt", localPath: "/local/down.txt", size: downloadBody.length },
    ]);

    await waitUntil(
      () =>
        engine.getTransfer(upTransfer.id)?.state.kind === "uploaded" &&
        engine.getTransfer(downTransfer.id)?.state.kind === "downloaded",
    );

    const batchEvent = events.find((e) => e.type === "batch-finished");
    expect(batchEvent).toEqual({ type: "batch-finished", uploaded: 1, downloaded: 1, failed: 0 });
  });
});

describe("TransferEngine — cancel", () => {
  test("cancelling a queued (not-yet-started) transfer drops it without ever running it", async () => {
    // Concurrency 1 + a first upload that hangs forever keeps the second
    // transfer sitting in "queued" so cancel() can target it deterministically.
    s3Mock.on(PutObjectCommand).callsFake(() => new Promise(() => {}));

    const store = new MemoryTransferStore();
    const reader = makeReader({ "/local/1.txt": new Uint8Array([1]), "/local/2.txt": new Uint8Array([2]) });
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      concurrency: 1,
    });

    const [first, second] = await engine.enqueue([
      { localPath: "/local/1.txt", size: 1, key: "1.txt" },
      { localPath: "/local/2.txt", size: 1, key: "2.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(first.id)?.state.kind === "sending");
    expect(engine.getTransfer(second.id)?.state.kind).toBe("queued");

    engine.cancel(second.id);

    expect(engine.getTransfer(second.id)).toBeUndefined();
    const persisted = await store.get(second.id);
    expect(persisted?.state).toEqual({ kind: "queued" });
  });

  test("cancelling an in-flight upload aborts it, drops it from the engine, and never persists a failed state", async () => {
    let rejectPut!: (err: unknown) => void;
    const hangingPut = new Promise<never>((_, reject) => {
      rejectPut = reject;
    });
    s3Mock.on(PutObjectCommand).callsFake(() => hangingPut);

    const store = new MemoryTransferStore();
    const reader = makeReader({ "/local/slow.txt": new Uint8Array([1, 2, 3]) });
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
      { localPath: "/local/slow.txt", size: 3, key: "slow.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "sending");

    engine.cancel(transfer.id);
    expect(engine.getTransfer(transfer.id)).toBeUndefined();

    // Simulate the abort actually tearing down the in-flight request.
    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    rejectPut(abortErr);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Still gone — never resurrected into a sticky "failed" transfer.
    expect(engine.getTransfer(transfer.id)).toBeUndefined();
    expect(events.some((e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed")).toBe(
      false,
    );

    // The store record is untouched at whatever it was pre-cancel — not
    // deleted, and not overwritten with a failed state.
    const persisted = await store.get(transfer.id);
    expect(persisted?.state.kind).toBe("sending");
  });

  test("cancelling an in-flight download discards its temp file and never persists a failed state", async () => {
    let rejectGet!: (err: unknown) => void;
    const hangingGet = new Promise<never>((_, reject) => {
      rejectGet = reject;
    });
    s3Mock.on(GetObjectCommand).callsFake(() => hangingGet);

    const store = new MemoryTransferStore();
    const { writer, discarded } = makeWriter();
    const events: EngineEvent[] = [];
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });
    engine.subscribe((e) => events.push(e));

    const [transfer] = await engine.enqueueDownloads([
      { key: "slow.bin", localPath: "/local/slow.bin", size: 100 },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "sending");

    engine.cancel(transfer.id);
    expect(engine.getTransfer(transfer.id)).toBeUndefined();

    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    rejectGet(abortErr);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(engine.getTransfer(transfer.id)).toBeUndefined();
    expect(events.some((e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed")).toBe(
      false,
    );
    // GetObject itself rejected before any bytes were staged, so there was
    // nothing on disk for the writer to clean up.
    expect(discarded).toEqual([]);

    const persisted = await store.get(transfer.id);
    expect(persisted?.state.kind).toBe("sending");
  });

  test("retry() can re-run a transfer after a previous cancel left it queued in the store", async () => {
    s3Mock.on(PutObjectCommand).callsFake(() => new Promise(() => {}));

    const store = new MemoryTransferStore();
    const reader = makeReader({ "/local/1.txt": new Uint8Array([1]), "/local/2.txt": new Uint8Array([2]) });
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store,
      concurrency: 1,
    });

    const [first, second] = await engine.enqueue([
      { localPath: "/local/1.txt", size: 1, key: "1.txt" },
      { localPath: "/local/2.txt", size: 1, key: "2.txt" },
    ]);
    await waitUntil(() => engine.getTransfer(first.id)?.state.kind === "sending");
    engine.cancel(second.id);
    expect(engine.getTransfer(second.id)).toBeUndefined();

    // The cancelled transfer is gone from this engine instance, but its
    // store record survives — a fresh engine picks it back up via
    // resumePending(), exactly like an interrupted transfer would.
    const freshStore = store;
    const secondEngine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader,
      store: freshStore,
      concurrency: 1,
    });
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(md5Hex(new Uint8Array([2]))) });
    await secondEngine.resumePending();
    await waitUntil(() => secondEngine.getTransfer(second.id)?.state.kind === "uploaded");
  });
});
