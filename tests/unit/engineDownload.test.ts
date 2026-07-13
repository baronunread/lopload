import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { TransferEngine } from "../../src/lib/engine";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import { md5Hex } from "../../src/lib/md5";
import type { LocalFileWriter } from "../../src/lib/s3/download";
import type { LocalFileReader } from "../../src/lib/s3/multipart";
import type { EngineEvent } from "../../src/lib/types";
import { DEFAULT_TUNING } from "../../src/lib/tuning";

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

  const allocated = new Map<string, Uint8Array>();

  const writer: LocalFileWriter = {
    tempPathFor(finalPath) {
      return `${finalPath}.tmp`;
    },
    async writeChunk(tempPath, chunk, isFirst) {
      if (isFirst || !staging.has(tempPath)) staging.set(tempPath, []);
      staging.get(tempPath)!.push(chunk);
    },
    async commit(tempPath, finalPath) {
      const buffer = allocated.get(tempPath);
      if (buffer) {
        committed.set(finalPath, buffer);
        allocated.delete(tempPath);
        return;
      }
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
      allocated.delete(tempPath);
    },
    async allocate(tempPath, size) {
      allocated.set(tempPath, new Uint8Array(size));
      staging.delete(tempPath);
    },
    async writeAt(tempPath, offset, chunk) {
      const buffer = allocated.get(tempPath);
      if (!buffer) throw new Error(`writeAt before allocate: ${tempPath}`);
      buffer.set(chunk, offset);
    },
    async sizeOf(tempPath) {
      const buffer = allocated.get(tempPath);
      if (buffer) return buffer.length;
      const chunks = staging.get(tempPath);
      if (!chunks) return null;
      return chunks.reduce((n, c) => n + c.length, 0);
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
      ETag: q(await md5Hex(body)),
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
  });

  test("mixed upload+download batch reports both counts on batch-finished", async () => {
    const uploadBody = new TextEncoder().encode("upload me");
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(await md5Hex(uploadBody)) });
    const downloadBody = new TextEncoder().encode("download me");
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(downloadBody) as never,
      ETag: q(await md5Hex(downloadBody)),
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
      tuning: () => ({ ...DEFAULT_TUNING, concurrentFiles: 1 }),
    });

    const [first, second] = await engine.enqueue([
      { localPath: "/local/1.txt", size: 1, key: "1.txt" },
      { localPath: "/local/2.txt", size: 1, key: "2.txt" },
    ]);

    await waitUntil(() => engine.getTransfer(first.id)?.state.kind === "sending");
    expect(engine.getTransfer(second.id)?.state.kind).toBe("queued");

    await engine.cancel(second.id);

    expect(engine.getTransfer(second.id)).toBeUndefined();
    const persisted = await store.get(second.id);
    expect(persisted).toBeNull();
  });

  test("cancelling an in-flight upload aborts it, drops it from the engine, and never persists a failed state", async () => {
    let rejectPut!: (err: unknown) => void;
    const hangingPut = new Promise<never>((_, reject) => {
      rejectPut = reject;
    });
    // If the abort lands before the SDK consumes the promise, the rejection
    // would otherwise surface as an unhandled error in this test.
    hangingPut.catch(() => {});
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
    // "Sending" state now lands before the PUT is actually issued (hash
    // setup is async) — wait for the request itself so the cancel really
    // aborts an in-flight upload.
    await waitUntil(() => s3Mock.commandCalls(PutObjectCommand).length > 0);

    await engine.cancel(transfer.id);
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

    // The store record is deleted along with the transfer.
    const persisted = await store.get(transfer.id);
    expect(persisted).toBeNull();
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

    await engine.cancel(transfer.id);
    expect(engine.getTransfer(transfer.id)).toBeUndefined();

    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    rejectGet(abortErr);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(engine.getTransfer(transfer.id)).toBeUndefined();
    expect(events.some((e) => e.type === "transfer-updated" && e.transfer.state.kind === "failed")).toBe(
      false,
    );
    // Cancelling always asks the writer to clean up, even here where GetObject
    // rejected before a byte was staged: the engine can't tell how far the
    // download got, and cancelling deletes the transfer's row (and with it the
    // part rows resume needs), so anything already on disk is unresumable
    // litter. discard() is best-effort and no-ops on a file that was never
    // created.
    expect(discarded).toEqual(["/local/slow.bin.tmp"]);

    const persisted = await store.get(transfer.id);
    expect(persisted).toBeNull();
  });

});

/**
 * A download's temp file is resume state for as long as the transfer's row
 * survives: a ranged download deliberately keeps both on failure so a retry
 * can pick up from the bytes already on disk. The moment the row is deleted,
 * though, the part rows go with it and nothing can ever resume from that file
 * again — so every path that deletes the row has to take the temp file too,
 * or downloads quietly pile up litter next to the user's files.
 */
describe("TransferEngine — download temp-file cleanup", () => {
  const MiB = 1024 * 1024;

  test("cancelling a ranged download removes the temp file it was resuming from", async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 32 * MiB, ETag: q("etag-not-md5") });
    let rejectGet!: (err: unknown) => void;
    const hangingGet = new Promise<never>((_, reject) => {
      rejectGet = reject;
    });
    s3Mock.on(GetObjectCommand).callsFake(() => hangingGet);

    const store = new MemoryTransferStore();
    const { writer, discarded } = makeWriter();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });

    // Big enough (and enough connections, per DEFAULT_TUNING) to take the
    // ranged path — the one that keeps its temp file on abort.
    const [transfer] = await engine.enqueueDownloads([
      { key: "big.bin", localPath: "/local/big.bin", size: 32 * MiB },
    ]);

    // Wait for all four range workers to be parked on their GET, not just for
    // the transfer to read "sending": the mocked client ignores abort signals,
    // so a worker that hasn't issued its GET yet would exit on the aborted
    // signal instead and leave nobody awaiting the hanging promise below.
    await waitUntil(() => s3Mock.commandCalls(GetObjectCommand).length === 4);

    await engine.cancel(transfer.id);
    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    rejectGet(abortErr);

    await waitUntil(() => discarded.includes("/local/big.bin.tmp"));
    expect(await store.get(transfer.id)).toBeNull();
  });

  test("dismissing a failed download removes the temp file it kept for a retry", async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error("network went away"));

    const store = new MemoryTransferStore();
    const { writer, discarded } = makeWriter();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });

    const [transfer] = await engine.enqueueDownloads([
      { key: "gone.bin", localPath: "/local/gone.bin", size: 100 },
    ]);
    await waitUntil(() => engine.getTransfer(transfer.id)?.state.kind === "failed");

    // Failing on its own keeps the transfer around — the user can still retry
    // it, so its bytes on disk are still worth something.
    expect(discarded).toEqual([]);

    await engine.dismiss(transfer.id);

    // Dismissing is the user saying they're done with it. The row goes, so the
    // bytes can never be resumed from and have to go too.
    expect(discarded).toEqual(["/local/gone.bin.tmp"]);
    expect(await store.get(transfer.id)).toBeNull();
  });

  test("a download interrupted by the app quitting doesn't leave its temp file behind", async () => {
    const store = new MemoryTransferStore();
    const { writer, discarded } = makeWriter();

    // A row still marked "sending" in the store is what a download that was
    // running when the app quit looks like on the next launch.
    await store.save({
      id: "t-1",
      connectionId: "conn-1",
      key: "big.bin",
      localPath: "/local/big.bin",
      size: 32 * MiB,
      partSize: 8 * MiB,
      direction: "download",
      state: { kind: "sending", percent: 42 },
      createdAt: 1,
      updatedAt: 1,
    });

    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });
    await engine.resumePending();

    // Downloads aren't picked back up across launches: the row is dropped,
    // which drops the part rows resume would need — so the half-written file
    // is dead weight rather than something to resume from.
    expect(await store.get("t-1")).toBeNull();
    expect(discarded).toEqual(["/local/big.bin.tmp"]);
  });

  test("leaves an upload's row alone — only downloads stage into a temp file", async () => {
    const store = new MemoryTransferStore();
    const { writer, discarded } = makeWriter();
    const engine = new TransferEngine({
      client,
      bucket: "b",
      connectionId: "conn-1",
      reader: makeReader({}),
      writer,
      store,
    });

    await store.save({
      id: "u-1",
      connectionId: "conn-1",
      key: "up.bin",
      localPath: "/local/up.bin",
      size: 10,
      partSize: 8 * MiB,
      direction: "upload",
      state: { kind: "failed", errorClass: "connection-dropped" },
      createdAt: 1,
      updatedAt: 1,
    });
    await engine.resumePending();
    await engine.dismiss("u-1");

    // An upload reads from the user's own file — there's no temp file to
    // remove, and reaching for one would mean deleting the source.
    expect(discarded).toEqual([]);
  });
});
