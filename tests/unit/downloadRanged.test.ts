import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { downloadTransfer, type LocalFileWriter } from "../../src/lib/s3/download";
import type { LocalFileReader } from "../../src/lib/s3/multipart";
import { MULTIPART_THRESHOLD } from "../../src/lib/s3/multipart";
import { md5Hex } from "../../src/lib/md5";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";

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

// The ranged path is gated on transfer.size >= MULTIPART_THRESHOLD, but range
// math uses the authoritative size from HeadObject — so tests can declare a
// large transfer.size while actually shipping ~100 bytes through the mock.
const TOTAL_SIZE = 100;
const PART_SIZE = 32; // → ranges of 32, 32, 32, 4 (parts 1..4)
const TOTAL_PARTS = 4;

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: "transfer-1",
    connectionId: "conn-1",
    key: "path/to/big.bin",
    localPath: "/local/dest/big.bin",
    size: MULTIPART_THRESHOLD,
    partSize: PART_SIZE,
    direction: "download",
    state: { kind: "sending", percent: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeData(size = TOTAL_SIZE): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 251;
  return data;
}

/** In-memory random-access fake writer + a reader over its buffers, so the
 * ranged path (allocate/writeAt/sizeOf + read-back verification) never
 * touches a real filesystem. */
function makeRangedFs() {
  const buffers = new Map<string, Uint8Array>();
  const committed = new Map<string, Uint8Array>();
  const discarded: string[] = [];
  const writeAtCalls: Array<{ offset: number; length: number }> = [];

  const writer: LocalFileWriter = {
    tempPathFor(finalPath) {
      return `${finalPath}.tmp`;
    },
    async writeChunk() {
      throw new Error("ranged path must not use sequential writeChunk");
    },
    async commit(tempPath, finalPath) {
      const buffer = buffers.get(tempPath);
      if (!buffer) throw new Error(`commit of missing temp file: ${tempPath}`);
      committed.set(finalPath, buffer);
      buffers.delete(tempPath);
    },
    async discard(tempPath) {
      discarded.push(tempPath);
      buffers.delete(tempPath);
    },
    async allocate(tempPath, size) {
      buffers.set(tempPath, new Uint8Array(size));
    },
    async writeAt(tempPath, offset, chunk) {
      const buffer = buffers.get(tempPath);
      if (!buffer) throw new Error(`writeAt before allocate: ${tempPath}`);
      writeAtCalls.push({ offset, length: chunk.length });
      buffer.set(chunk, offset);
    },
    async sizeOf(tempPath) {
      return buffers.get(tempPath)?.length ?? null;
    },
  };

  const reader: LocalFileReader = {
    async size(path) {
      return buffers.get(path)?.length ?? 0;
    },
    async readChunk(path, offset, length) {
      const buffer = buffers.get(path) ?? new Uint8Array(0);
      return buffer.slice(offset, offset + length);
    },
  };

  return { writer, reader, buffers, committed, discarded, writeAtCalls };
}

function parseRange(range: string): { start: number; end: number } {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!m) throw new Error(`unexpected Range header: ${range}`);
  return { start: Number(m[1]), end: Number(m[2]) };
}

/** A ReadableStream that dribbles `slice` out in `chunkSize`-byte pieces,
 * mimicking the ~64 KiB chunking a real HTTP body stream does — used to
 * exercise writeAt() coalescing in the ranged worker loop. */
function chunkedStream(slice: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= slice.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, slice.length);
      controller.enqueue(slice.slice(offset, end));
      offset = end;
    },
  });
}

/** Mocks HEAD + ranged GETs over `data`. Returns the Range headers observed. */
function mockRangedObject(data: Uint8Array, etagHex: string) {
  const ranges: string[] = [];
  s3Mock.on(HeadObjectCommand).resolves({
    ContentLength: data.length,
    ETag: q(etagHex),
  });
  s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
    if (!input.Range) throw new Error("expected a ranged GET");
    ranges.push(input.Range);
    const { start, end } = parseRange(input.Range);
    const slice = data.slice(start, end + 1);
    return {
      Body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      }),
      ContentLength: slice.length,
      ETag: q(etagHex),
    };
  });
  return ranges;
}

describe("downloadTransfer — ranged parallel path", () => {
  test("issues correct Range headers, writes at correct offsets, commits verified bytes", async () => {
    const data = makeData();
    const etag = await md5Hex(data);
    const ranges = mockRangedObject(data, etag);

    const transfer = makeTransfer();
    const fs = makeRangedFs();
    const store = new MemoryTransferStore();
    const progress: Array<[number, number]> = [];

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store,
      connections: 2,
      onProgress: (received, total) => progress.push([received, total]),
    });

    expect(ranges.sort()).toEqual(
      ["bytes=0-31", "bytes=32-63", "bytes=64-95", "bytes=96-99"].sort(),
    );
    const offsets = fs.writeAtCalls.map((c) => c.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 32, 64, 96]);
    expect(fs.committed.get(transfer.localPath)).toEqual(data);
    expect(fs.discarded).toHaveLength(0);

    // Progress is monotonic and reaches the authoritative total.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0]);
      expect(progress[i][1]).toBe(TOTAL_SIZE);
    }
    expect(progress[progress.length - 1][0]).toBe(TOTAL_SIZE);

    // Every range was persisted for resume, with the marker empty etag.
    const parts = await store.listParts(transfer.id);
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4]);
    expect(parts.every((p) => p.etag === "")).toBe(true);
    expect(parts.map((p) => p.size)).toEqual([32, 32, 32, 4]);
  });

  test("in-flight GETs never exceed the connections limit", async () => {
    const data = makeData();
    const etag = await md5Hex(data);

    let inFlight = 0;
    let maxInFlight = 0;
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.length, ETag: q(etag) });
    s3Mock.on(GetObjectCommand).callsFake(async (input: { Range?: string }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      const { start, end } = parseRange(input.Range!);
      return { Body: data.slice(start, end + 1), ContentLength: end - start + 1, ETag: q(etag) };
    });

    const transfer = makeTransfer();
    const fs = makeRangedFs();

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store: new MemoryTransferStore(),
      connections: 2,
    });

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(fs.committed.get(transfer.localPath)).toEqual(data);
  });

  test("resume: persisted ranges are skipped, progress is seeded, only missing ranges fetched", async () => {
    const data = makeData();
    const etag = await md5Hex(data);
    const ranges = mockRangedObject(data, etag);

    const transfer = makeTransfer();
    const fs = makeRangedFs();
    const store = new MemoryTransferStore();

    // Previous attempt: ranges 1 and 3 landed on disk and were persisted.
    const tempPath = fs.writer.tempPathFor(transfer.localPath);
    const partial = new Uint8Array(TOTAL_SIZE);
    partial.set(data.slice(0, 32), 0);
    partial.set(data.slice(64, 96), 64);
    fs.buffers.set(tempPath, partial);
    await store.saveParts([
      { transferId: transfer.id, partNumber: 1, etag: "", size: 32 },
      { transferId: transfer.id, partNumber: 3, etag: "", size: 32 },
    ]);

    const progress: Array<[number, number]> = [];
    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store,
      connections: 2,
      onProgress: (received, total) => progress.push([received, total]),
    });

    expect(ranges.sort()).toEqual(["bytes=32-63", "bytes=96-99"].sort());
    expect(progress[0]).toEqual([64, TOTAL_SIZE]); // seeded with resumed bytes
    expect(progress[progress.length - 1][0]).toBe(TOTAL_SIZE);
    expect(fs.committed.get(transfer.localPath)).toEqual(data);
  });

  test("resume: temp file size mismatch invalidates persisted ranges → full re-download", async () => {
    const data = makeData();
    const etag = await md5Hex(data);
    const ranges = mockRangedObject(data, etag);

    const transfer = makeTransfer();
    const fs = makeRangedFs();
    const store = new MemoryTransferStore();

    // Part rows exist, but the temp file is gone (sizeOf → null).
    await store.saveParts([
      { transferId: transfer.id, partNumber: 1, etag: "", size: 32 },
      { transferId: transfer.id, partNumber: 2, etag: "", size: 32 },
    ]);

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store,
      connections: 2,
    });

    expect(ranges).toHaveLength(TOTAL_PARTS);
    expect(fs.committed.get(transfer.localPath)).toEqual(data);
  });

  test("network error keeps the temp file and part rows (they are the resume state)", async () => {
    const data = makeData();
    const etag = await md5Hex(data);

    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.length, ETag: q(etag) });
    let calls = 0;
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      calls++;
      if (calls > 1) {
        return Promise.reject(new Error("socket hang up"));
      }
      const { start, end } = parseRange(input.Range!);
      return { Body: data.slice(start, end + 1), ContentLength: end - start + 1, ETag: q(etag) };
    });

    const transfer = makeTransfer();
    const fs = makeRangedFs();
    const store = new MemoryTransferStore();

    await expect(
      downloadTransfer(transfer, {
        client,
        bucket: "b",
        writer: fs.writer,
        reader: fs.reader,
        store,
        connections: 2,
      }),
    ).rejects.toThrow("socket hang up");

    const tempPath = fs.writer.tempPathFor(transfer.localPath);
    expect(fs.discarded).toHaveLength(0);
    expect(fs.buffers.has(tempPath)).toBe(true);
    expect(fs.committed.size).toBe(0);
    // The one range that completed is persisted for the next attempt.
    const parts = await store.listParts(transfer.id);
    expect(parts).toHaveLength(1);
  });

  test("checksum mismatch discards the temp file and rejects with VerificationError", async () => {
    const data = makeData();
    mockRangedObject(data, "0".repeat(32)); // wrong plain-MD5 ETag

    const transfer = makeTransfer();
    const fs = makeRangedFs();

    await expect(
      downloadTransfer(transfer, {
        client,
        bucket: "b",
        writer: fs.writer,
        reader: fs.reader,
        store: new MemoryTransferStore(),
        connections: 2,
      }),
    ).rejects.toThrow(/checksum/);

    expect(fs.discarded).toEqual([fs.writer.tempPathFor(transfer.localPath)]);
    expect(fs.committed.size).toBe(0);
  });

  test("multipart-style ETag (not plain MD5) skips checksum verification and commits", async () => {
    const data = makeData();
    const ranges = mockRangedObject(data, `${"a".repeat(32)}-4`);

    const transfer = makeTransfer();
    const fs = makeRangedFs();

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store: new MemoryTransferStore(),
      connections: 3,
    });

    expect(ranges).toHaveLength(TOTAL_PARTS);
    expect(fs.committed.get(transfer.localPath)).toEqual(data);
  });

  test("abort stops all connections, keeps the temp file, and rejects with the abort error", async () => {
    const data = makeData();
    const etag = await md5Hex(data);

    const controller = new AbortController();
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.length, ETag: q(etag) });
    s3Mock.on(GetObjectCommand).callsFake(() => {
      // Hang until aborted, then reject the way the SDK does.
      return new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const transfer = makeTransfer();
    const fs = makeRangedFs();

    const done = downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store: new MemoryTransferStore(),
      connections: 2,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const err = await done.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");

    // Temp file kept for resume; nothing committed or discarded.
    expect(fs.discarded).toHaveLength(0);
    expect(fs.buffers.has(fs.writer.tempPathFor(transfer.localPath))).toBe(true);
    expect(fs.committed.size).toBe(0);
  });

  test("connections: 1 uses the streaming path even above the threshold", async () => {
    const body = new TextEncoder().encode("streamed, not ranged");
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      expect(input.Range).toBeUndefined();
      return {
        Body: body,
        ContentLength: body.length,
        ETag: q("a".repeat(32) + "-2"),
      };
    });

    const transfer = makeTransfer({ size: MULTIPART_THRESHOLD });
    const fs = makeRangedFs();
    // The streaming path uses sequential writeChunk; give it a working one.
    const staged: Uint8Array[] = [];
    fs.writer.writeChunk = async (_tempPath, chunk) => {
      staged.push(chunk);
    };
    fs.writer.commit = async (_tempPath, finalPath) => {
      fs.committed.set(finalPath, staged[0] ?? new Uint8Array(0));
    };

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store: new MemoryTransferStore(),
      connections: 1,
    });

    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(fs.committed.get(transfer.localPath)).toEqual(body);
  });

  test("small file uses the streaming path even with many connections", async () => {
    const body = new TextEncoder().encode("tiny");
    const etag = await md5Hex(body);
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      expect(input.Range).toBeUndefined();
      return { Body: body, ContentLength: body.length, ETag: q(etag) };
    });

    const transfer = makeTransfer({ size: body.length });
    const fs = makeRangedFs();
    const staged: Uint8Array[] = [];
    fs.writer.writeChunk = async (_tempPath, chunk) => {
      staged.push(chunk);
    };
    fs.writer.commit = async (_tempPath, finalPath) => {
      fs.committed.set(finalPath, staged[0] ?? new Uint8Array(0));
    };

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store: new MemoryTransferStore(),
      connections: 8,
    });

    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
    expect(fs.committed.get(transfer.localPath)).toEqual(body);
  });
});

describe("downloadRanged — writeAt coalescing", () => {
  // 64 chunks of 32 KiB — matches the WRITE_BUFFER_WINDOW (2 MiB) so a full
  // part should collapse into (about) one writeAt() call instead of 64.
  const CHUNK_SIZE = 32 * 1024;
  const CHUNKS_PER_PART = 64;
  const COALESCE_PART_SIZE = CHUNK_SIZE * CHUNKS_PER_PART; // 2 MiB

  function makeCoalesceTransfer(overrides: Partial<Transfer> = {}): Transfer {
    const now = Date.now();
    return {
      id: "transfer-coalesce",
      connectionId: "conn-1",
      key: "path/to/big.bin",
      localPath: "/local/dest/big.bin",
      size: MULTIPART_THRESHOLD,
      partSize: COALESCE_PART_SIZE,
      direction: "download",
      state: { kind: "sending", percent: 0 },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  /** Instruments a ranged fs fake so events (`writeAt:<part>` / `save:<part>`)
   * are recorded in call order, to assert flush-before-saveParts ordering. */
  function makeInstrumentedFs() {
    const fs = makeRangedFs();
    const events: string[] = [];
    const originalWriteAt = fs.writer.writeAt.bind(fs.writer);
    fs.writer.writeAt = async (tempPath, offset, chunk) => {
      await originalWriteAt(tempPath, offset, chunk);
      events.push(`writeAt:${offset}:${chunk.length}`);
    };
    return { ...fs, events };
  }

  test("many small chunks per part collapse into ~1 writeAt call per part", async () => {
    const totalSize = COALESCE_PART_SIZE * 2 + 1024; // 2 full parts + a small tail part
    const data = makeData(totalSize);
    const etag = await md5Hex(data);

    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.length, ETag: q(etag) });
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      if (!input.Range) throw new Error("expected a ranged GET");
      const { start, end } = parseRange(input.Range);
      const slice = data.slice(start, end + 1);
      return {
        Body: chunkedStream(slice, CHUNK_SIZE),
        ContentLength: slice.length,
        ETag: q(etag),
      };
    });

    const transfer = makeCoalesceTransfer();
    const fs = makeRangedFs();
    const store = new MemoryTransferStore();

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store,
      connections: 2,
    });

    // 3 parts total (2 full 2 MiB parts + one 1 KiB tail part) — each part's
    // bytes fully fit in one buffered window, so each should flush ~once.
    expect(fs.writeAtCalls.length).toBeLessThanOrEqual(3);
    expect(fs.writeAtCalls.length).toBeGreaterThan(0);
    expect(fs.writeAtCalls.length).toBeLessThan(CHUNKS_PER_PART * 2); // nowhere near per-chunk

    expect(fs.committed.get(transfer.localPath)).toEqual(data);
    const parts = await store.listParts(transfer.id);
    expect(parts.map((p) => p.partNumber).sort()).toEqual([1, 2, 3]);
  });

  test("a part's bytes are flushed to disk before saveParts records it as complete", async () => {
    const totalSize = COALESCE_PART_SIZE; // single part
    const data = makeData(totalSize);
    const etag = await md5Hex(data);

    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.length, ETag: q(etag) });
    s3Mock.on(GetObjectCommand).callsFake((input: { Range?: string }) => {
      const { start, end } = parseRange(input.Range!);
      const slice = data.slice(start, end + 1);
      return {
        Body: chunkedStream(slice, CHUNK_SIZE),
        ContentLength: slice.length,
        ETag: q(etag),
      };
    });

    const transfer = makeCoalesceTransfer();
    const fs = makeInstrumentedFs();
    const events = fs.events;
    const store = new MemoryTransferStore();
    const originalSaveParts = store.saveParts.bind(store);
    store.saveParts = async (parts) => {
      await originalSaveParts(parts);
      for (const p of parts) events.push(`save:${p.partNumber}`);
    };

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer: fs.writer,
      reader: fs.reader,
      store,
      // Single part → pool size collapses to 1 worker regardless, so this
      // stays deterministic while still exercising the ranged path (which
      // requires connections > 1).
      connections: 2,
    });

    expect(events.length).toBeGreaterThan(0);
    // Every save event must be preceded by at least one writeAt for that part —
    // i.e. bytes hit disk before the part is marked complete for resume.
    const firstSaveIdx = events.findIndex((e) => e.startsWith("save:"));
    expect(firstSaveIdx).toBeGreaterThan(-1);
    const writeAtBeforeSave = events.slice(0, firstSaveIdx).some((e) => e.startsWith("writeAt:"));
    expect(writeAtBeforeSave).toBe(true);
    expect(fs.committed.get(transfer.localPath)).toEqual(data);
  });

  test("error mid-part (before the buffered window flushes) leaves the part unrecorded", async () => {
    // Only 2 small chunks arrive (well under the 2 MiB window) before the
    // stream errors — nothing should have flushed, so nothing should save.
    const totalSize = COALESCE_PART_SIZE;
    const data = makeData(totalSize);
    const etag = await md5Hex(data);

    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: data.length, ETag: q(etag) });
    s3Mock.on(GetObjectCommand).callsFake(() => {
      let reads = 0;
      return {
        Body: new ReadableStream<Uint8Array>({
          pull(controller) {
            reads++;
            if (reads === 1) {
              controller.enqueue(data.slice(0, CHUNK_SIZE));
              return;
            }
            if (reads === 2) {
              controller.enqueue(data.slice(CHUNK_SIZE, CHUNK_SIZE * 2));
              return;
            }
            controller.error(new Error("connection reset"));
          },
        }),
        ContentLength: data.length,
        ETag: q(etag),
      };
    });

    const transfer = makeCoalesceTransfer();
    const fs = makeRangedFs();
    const store = new MemoryTransferStore();

    await expect(
      downloadTransfer(transfer, {
        client,
        bucket: "b",
        writer: fs.writer,
        reader: fs.reader,
        store,
        connections: 2,
      }),
    ).rejects.toThrow("connection reset");

    // The buffered bytes from before the error were never flushed (under the
    // 2 MiB window), and the part must not be recorded as complete.
    expect(fs.writeAtCalls).toHaveLength(0);
    const parts = await store.listParts(transfer.id);
    expect(parts).toHaveLength(0);
    expect(fs.committed.size).toBe(0);
    // Temp file is kept for resume (as with any other mid-download error).
    expect(fs.discarded).toHaveLength(0);
  });
});
