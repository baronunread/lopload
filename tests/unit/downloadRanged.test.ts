import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadTransfer } from "../../src/lib/s3/download";
import { MULTIPART_THRESHOLD } from "../../src/lib/s3/multipart";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/minio";
import { bucketProbe } from "../support/bucketProbe";
import { localFileReader, localFileWriter } from "../support/localFiles";
import { nativeFetch } from "../setup";

let bucket: Bucket;
let workdir: string;

beforeAll(async () => {
  bucket = await freshBucket();
  workdir = await mkdtemp(join(tmpdir(), "lopload-download-ranged-test-"));
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

function urlOf(input: Parameters<FetchFn>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

// The ranged path is gated on transfer.size >= MULTIPART_THRESHOLD, but range
// math uses the authoritative size from HeadObject — so tests can declare a
// large transfer.size while actually shipping ~100 bytes through the object.
const TOTAL_SIZE = 100;
const PART_SIZE = 32; // → ranges of 32, 32, 32, 4 (parts 1..4)
const TOTAL_PARTS = 4;

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: "transfer-1",
    connectionId: "conn-1",
    key: "path/to/big.bin",
    localPath: join(workdir, "big.bin"),
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

let fileCounter = 0;
/** A fresh localPath (real file, never yet created) for a test — keeps
 * concurrently-described tests from colliding on the same temp file. */
function freshLocalPath(name: string): string {
  return join(workdir, `${fileCounter++}-${name}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Instruments the real localFileWriter, recording every writeAt/discard
 * call — so ranged-path assertions (offsets, coalescing, cleanup) can be
 * made against a real temp file instead of an in-memory fake. */
function trackedWriter() {
  const writeAtCalls: Array<{ offset: number; length: number }> = [];
  const discarded: string[] = [];
  const writer = {
    ...localFileWriter,
    async writeAt(tempPath: string, offset: number, chunk: Uint8Array) {
      writeAtCalls.push({ offset, length: chunk.length });
      await localFileWriter.writeAt(tempPath, offset, chunk);
    },
    async discard(tempPath: string) {
      discarded.push(tempPath);
      await localFileWriter.discard(tempPath);
    },
  };
  return { writer, writeAtCalls, discarded };
}

/** Captures the Range header of every GET matching `key`, letting the
 * request through to real storage unmodified. */
function captureRanges(inner: FetchFn, key: string): { fetchFn: FetchFn; ranges: string[] } {
  const ranges: string[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && url.includes(key)) {
      const range = new Headers(init?.headers).get("range");
      if (range) ranges.push(range);
    }
    return inner(input, init);
  };
  return { fetchFn, ranges };
}

/** Records every request's method + URL, matching `key` — used to assert a
 * request kind (e.g. HEAD) never happened. */
function captureRequests(inner: FetchFn, key: string): { fetchFn: FetchFn; requests: string[] } {
  const requests: string[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes(key)) requests.push(method);
    return inner(input, init);
  };
  return { fetchFn, requests };
}

/** Delays every matching GET by `delayMs` while tracking how many are ever
 * concurrently in flight — the real-backend equivalent of the old mock's
 * inline concurrency counter. */
function concurrencyTrackingDelay(
  inner: FetchFn,
  key: string,
  delayMs: number,
): { fetchFn: FetchFn; maxInFlight: () => number } {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn: FetchFn = async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" || !url.includes(key)) return inner(input, init);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      return await inner(input, init);
    } finally {
      inFlight--;
    }
  };
  return { fetchFn, maxInFlight: () => maxInFlight };
}

/** Lets the first `passCount` matching GETs through untouched, then rejects
 * every subsequent matching GET with a plain network-shaped error. There's
 * no `Fault` for "succeed N times, then fail" (faultyFetch's `times` counts
 * down how many times a fault itself fires, the opposite order), so this is
 * implemented locally. */
function failAfter(inner: FetchFn, key: string, passCount: number, message: string): FetchFn {
  let calls = 0;
  return async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" || !url.includes(key)) return inner(input, init);
    calls++;
    if (calls > passCount) throw new Error(message);
    return inner(input, init);
  };
}

/** Rewrites a real response's ETag to an arbitrary value — corruptEtag only
 * ever rewrites to a fixed all-zero MD5-shaped value, but this suite also
 * needs a *multipart-style* (dashed) ETag to prove verification is skipped
 * for those.
 *
 * Copies headers with `forEach` + `set` rather than `new Headers(res.headers)`
 * — under happy-dom (registered globally by tests/setup for the DOM the UI
 * renders into), that copy-constructor silently drops `content-length`,
 * which the ranged path treats as authoritative (HEAD's ContentLength, not
 * transfer.size). faultyFetch's own corruptEtag/truncateBody faults have
 * the same quirk; this suite avoids applying those two to HEAD responses. */
function rewriteEtag(inner: FetchFn, key: string, method: string, etag: string): FetchFn {
  return async (input, init) => {
    const url = urlOf(input);
    const m = (init?.method ?? "GET").toUpperCase();
    if (m !== method.toUpperCase() || !url.includes(key)) return inner(input, init);
    const res = await inner(input, init);
    const headers = new Headers();
    res.headers.forEach((v, k) => headers.set(k, v));
    headers.set("etag", `"${etag}"`);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * Substitutes a fabricated, deliberately-erroring body for one ranged GET
 * (after a real preceding HEAD so ContentLength/ETag stay authoritative) —
 * the one case in this suite where no `Fault` or real-network timing can
 * deterministically reproduce "exactly 2 chunks arrive, then the stream
 * dies," which the coalescing test needs to prove nothing partial gets
 * recorded as complete.
 */
function erroringStreamOnce(
  inner: FetchFn,
  key: string,
  chunks: Uint8Array[],
  errorMessage: string,
): FetchFn {
  let fired = false;
  return async (input, init) => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" || !url.includes(key) || fired) return inner(input, init);
    fired = true;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i]);
          i++;
          return;
        }
        controller.error(new Error(errorMessage));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-length": String(total) },
    });
  };
}

describe("downloadTransfer — ranged parallel path", () => {
  test("issues correct Range headers, writes at correct offsets, commits verified bytes", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/basic.bin", data);
    const { fetchFn, ranges } = captureRanges(nativeFetch, "ranged/basic.bin");

    const transfer = makeTransfer({ key: "ranged/basic.bin", localPath: freshLocalPath("basic.bin") });
    const { writer, writeAtCalls } = trackedWriter();
    const store = new MemoryTransferStore();
    const progress: Array<[number, number]> = [];

    await downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer,
      reader: localFileReader,
      store,
      connections: 2,
      onProgress: (received, total) => progress.push([received, total]),
    });

    expect(ranges.sort()).toEqual(
      ["bytes=0-31", "bytes=32-63", "bytes=64-95", "bytes=96-99"].sort(),
    );
    const offsets = writeAtCalls.map((c) => c.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 32, 64, 96]);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);

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
    await bucketProbe(bucket.client, bucket.name).put("ranged/concurrency.bin", data);
    const { fetchFn, maxInFlight } = concurrencyTrackingDelay(nativeFetch, "ranged/concurrency.bin", 10);

    const transfer = makeTransfer({
      key: "ranged/concurrency.bin",
      localPath: freshLocalPath("concurrency.bin"),
    });

    await downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer: localFileWriter,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      connections: 2,
    });

    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(2);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);
  });

  test("resume: persisted ranges are skipped, progress is seeded, only missing ranges fetched", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/resume.bin", data);
    const { fetchFn, ranges } = captureRanges(nativeFetch, "ranged/resume.bin");

    const transfer = makeTransfer({ key: "ranged/resume.bin", localPath: freshLocalPath("resume.bin") });
    const store = new MemoryTransferStore();

    // Previous attempt: ranges 1 and 3 landed on disk and were persisted.
    const tempPath = localFileWriter.tempPathFor(transfer.localPath);
    await localFileWriter.allocate(tempPath, TOTAL_SIZE);
    await localFileWriter.writeAt(tempPath, 0, data.slice(0, 32));
    await localFileWriter.writeAt(tempPath, 64, data.slice(64, 96));
    await store.saveParts([
      { transferId: transfer.id, partNumber: 1, etag: "", size: 32 },
      { transferId: transfer.id, partNumber: 3, etag: "", size: 32 },
    ]);

    const progress: Array<[number, number]> = [];
    await downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer: localFileWriter,
      reader: localFileReader,
      store,
      connections: 2,
      onProgress: (received, total) => progress.push([received, total]),
    });

    expect(ranges.sort()).toEqual(["bytes=32-63", "bytes=96-99"].sort());
    expect(progress[0]).toEqual([64, TOTAL_SIZE]); // seeded with resumed bytes
    expect(progress[progress.length - 1][0]).toBe(TOTAL_SIZE);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);
  });

  test("resume: temp file size mismatch invalidates persisted ranges → full re-download", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/mismatch.bin", data);
    const { fetchFn, ranges } = captureRanges(nativeFetch, "ranged/mismatch.bin");

    const transfer = makeTransfer({
      key: "ranged/mismatch.bin",
      localPath: freshLocalPath("mismatch.bin"),
    });
    const store = new MemoryTransferStore();

    // Part rows exist, but the temp file is gone (sizeOf → null).
    await store.saveParts([
      { transferId: transfer.id, partNumber: 1, etag: "", size: 32 },
      { transferId: transfer.id, partNumber: 2, etag: "", size: 32 },
    ]);

    await downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer: localFileWriter,
      reader: localFileReader,
      store,
      connections: 2,
    });

    expect(ranges).toHaveLength(TOTAL_PARTS);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);
  });

  test("network error keeps the temp file and part rows (they are the resume state)", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/network-error.bin", data);
    // First GET (whichever part a worker starts with) succeeds; every GET
    // after that fails — connections: 2 guarantees at least one succeeds
    // before the failure hits.
    const fetchFn = failAfter(nativeFetch, "ranged/network-error.bin", 1, "socket hang up");

    const transfer = makeTransfer({
      key: "ranged/network-error.bin",
      localPath: freshLocalPath("network-error.bin"),
    });
    const { writer, discarded } = trackedWriter();
    const store = new MemoryTransferStore();

    await expect(
      downloadTransfer(transfer, {
        client: clientWith(fetchFn),
        bucket: bucket.name,
        writer,
        reader: localFileReader,
        store,
        connections: 2,
      }),
    ).rejects.toThrow("socket hang up");

    const tempPath = writer.tempPathFor(transfer.localPath);
    expect(discarded).toHaveLength(0);
    expect(await fileExists(tempPath)).toBe(true);
    expect(await fileExists(transfer.localPath)).toBe(false);
    // The one range that completed is persisted for the next attempt.
    const parts = await store.listParts(transfer.id);
    expect(parts).toHaveLength(1);
  });

  test("checksum mismatch discards the temp file and rejects with VerificationError", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/checksum.bin", data);
    // The ranged path's authoritative ETag comes from the HEAD response, not
    // from any individual ranged GET, so the fault has to corrupt that one.
    // faultyFetch's own corruptEtag fault would work here too, but it drops
    // content-length on HEAD responses under this test environment (see
    // rewriteEtag's comment above) — reuse rewriteEtag instead, since a
    // fixed all-zero value is just as good a "corrupt" ETag as any other.
    const fetchFn = rewriteEtag(nativeFetch, "ranged/checksum.bin", "HEAD", "0".repeat(32));

    const transfer = makeTransfer({ key: "ranged/checksum.bin", localPath: freshLocalPath("checksum.bin") });
    const { writer, discarded } = trackedWriter();

    await expect(
      downloadTransfer(transfer, {
        client: clientWith(fetchFn),
        bucket: bucket.name,
        writer,
        reader: localFileReader,
        store: new MemoryTransferStore(),
        connections: 2,
      }),
    ).rejects.toThrow(/checksum/);

    expect(discarded).toEqual([writer.tempPathFor(transfer.localPath)]);
    expect(await fileExists(transfer.localPath)).toBe(false);
  });

  test("multipart-style ETag (not plain MD5) skips checksum verification and commits", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/multipart-etag.bin", data);
    // The ranged path's authoritative ETag comes from HEAD, not from any
    // individual ranged GET.
    const fetchFn = rewriteEtag(nativeFetch, "ranged/multipart-etag.bin", "HEAD", `${"a".repeat(32)}-4`);
    const { fetchFn: counted, requests } = captureRequests(fetchFn, "ranged/multipart-etag.bin");

    const transfer = makeTransfer({
      key: "ranged/multipart-etag.bin",
      localPath: freshLocalPath("multipart-etag.bin"),
    });

    await downloadTransfer(transfer, {
      client: clientWith(counted),
      bucket: bucket.name,
      writer: localFileWriter,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      connections: 3,
    });

    expect(requests.filter((m) => m === "GET")).toHaveLength(TOTAL_PARTS);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);
  });

  test("abort stops all connections, keeps the temp file, and rejects with the abort error", async () => {
    const data = makeData();
    await bucketProbe(bucket.client, bucket.name).put("ranged/abort.bin", data);

    let started = 0;
    const fetchFn: FetchFn = async (input, init) => {
      const url = urlOf(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET" || !url.includes("ranged/abort.bin")) return nativeFetch(input, init);
      started++;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = () => {
          const err = new Error("Request aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (!signal) return;
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort);
      });
    };

    const transfer = makeTransfer({ key: "ranged/abort.bin", localPath: freshLocalPath("abort.bin") });
    const { writer, discarded } = trackedWriter();
    const controller = new AbortController();

    const done = downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      connections: 2,
      signal: controller.signal,
    });

    await (async () => {
      const start = Date.now();
      while (started < 2 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    controller.abort();

    const err = await done.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("AbortError");

    // Temp file kept for resume; nothing committed or discarded.
    expect(discarded).toHaveLength(0);
    expect(await fileExists(writer.tempPathFor(transfer.localPath))).toBe(true);
    expect(await fileExists(transfer.localPath)).toBe(false);
  });

  test("connections: 1 uses the streaming path even above the threshold", async () => {
    const body = new TextEncoder().encode("streamed, not ranged");
    await bucketProbe(bucket.client, bucket.name).put("ranged/stream1.bin", body);
    const { fetchFn, requests } = captureRequests(nativeFetch, "ranged/stream1.bin");

    const transfer = makeTransfer({
      key: "ranged/stream1.bin",
      localPath: freshLocalPath("stream1.bin"),
      size: MULTIPART_THRESHOLD,
    });

    await downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer: localFileWriter,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      connections: 1,
    });

    expect(requests.filter((m) => m === "HEAD")).toHaveLength(0);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(body);
  });

  test("small file uses the streaming path even with many connections", async () => {
    const body = new TextEncoder().encode("tiny");
    await bucketProbe(bucket.client, bucket.name).put("ranged/tiny.bin", body);
    const { fetchFn, requests } = captureRequests(nativeFetch, "ranged/tiny.bin");

    const transfer = makeTransfer({
      key: "ranged/tiny.bin",
      localPath: freshLocalPath("tiny.bin"),
      size: body.length,
    });

    await downloadTransfer(transfer, {
      client: clientWith(fetchFn),
      bucket: bucket.name,
      writer: localFileWriter,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      connections: 8,
    });

    expect(requests.filter((m) => m === "HEAD")).toHaveLength(0);
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(body);
  });
});

describe("downloadRanged — writeAt coalescing", () => {
  // 64 chunks of 32 KiB — matches the WRITE_BUFFER_WINDOW (2 MiB), so a full
  // part collapses into a small, bounded number of writeAt() calls rather
  // than one per network chunk regardless of exactly how the real transport
  // slices the response body.
  const CHUNK_SIZE = 32 * 1024;
  const CHUNKS_PER_PART = 64;
  const COALESCE_PART_SIZE = CHUNK_SIZE * CHUNKS_PER_PART; // 2 MiB

  function makeCoalesceTransfer(overrides: Partial<Transfer> = {}): Transfer {
    const now = Date.now();
    return {
      id: "transfer-coalesce",
      connectionId: "conn-1",
      key: "path/to/big.bin",
      localPath: freshLocalPath("coalesce.bin"),
      size: MULTIPART_THRESHOLD,
      partSize: COALESCE_PART_SIZE,
      direction: "download",
      state: { kind: "sending", percent: 0 },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  test("many small chunks per part collapse into a small, bounded number of writeAt calls", async () => {
    const totalSize = COALESCE_PART_SIZE * 2 + 1024; // 2 full parts + a small tail part
    const data = makeData(totalSize);
    await bucketProbe(bucket.client, bucket.name).put("ranged/coalesce-1.bin", data);

    const transfer = makeCoalesceTransfer({ key: "ranged/coalesce-1.bin", localPath: freshLocalPath("c1.bin") });
    const { writer, writeAtCalls } = trackedWriter();
    const store = new MemoryTransferStore();

    await downloadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      writer,
      reader: localFileReader,
      store,
      connections: 2,
    });

    // 3 parts total (2 full 2 MiB parts + one 1 KiB tail part) — each part's
    // bytes fully fit in one buffered window, so each should flush ~once
    // regardless of how many network-level chunks the real transport used.
    expect(writeAtCalls.length).toBeLessThanOrEqual(3);
    expect(writeAtCalls.length).toBeGreaterThan(0);
    expect(writeAtCalls.length).toBeLessThan(CHUNKS_PER_PART * 2); // nowhere near per-chunk

    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);
    const parts = await store.listParts(transfer.id);
    expect(parts.map((p) => p.partNumber).sort()).toEqual([1, 2, 3]);
  });

  test("a part's bytes are flushed to disk before saveParts records it as complete", async () => {
    const totalSize = COALESCE_PART_SIZE; // single part
    const data = makeData(totalSize);
    await bucketProbe(bucket.client, bucket.name).put("ranged/coalesce-2.bin", data);

    const transfer = makeCoalesceTransfer({ key: "ranged/coalesce-2.bin", localPath: freshLocalPath("c2.bin") });
    const { writer } = trackedWriter();
    const events: string[] = [];
    const originalWriteAt = writer.writeAt.bind(writer);
    writer.writeAt = async (tempPath, offset, chunk) => {
      await originalWriteAt(tempPath, offset, chunk);
      events.push(`writeAt:${offset}:${chunk.length}`);
    };
    const store = new MemoryTransferStore();
    const originalSaveParts = store.saveParts.bind(store);
    store.saveParts = async (parts) => {
      await originalSaveParts(parts);
      for (const p of parts) events.push(`save:${p.partNumber}`);
    };

    await downloadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      writer,
      reader: localFileReader,
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
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(data);
  });

  test("error mid-part (before the buffered window flushes) leaves the part unrecorded", async () => {
    // Only 2 small chunks arrive (well under the 2 MiB window) before the
    // stream errors — nothing should have flushed, so nothing should save.
    // No real fault or network-timing seam can deterministically force
    // "exactly 2 chunks, then a hard stream error," so this one request's
    // body is fabricated (after a real preceding HEAD keeps ContentLength
    // authoritative) — seam-level fault injection, same as the rest of the
    // suite, just with a custom one-off action.
    const totalSize = COALESCE_PART_SIZE;
    const data = makeData(totalSize);
    await bucketProbe(bucket.client, bucket.name).put("ranged/coalesce-3.bin", data);
    const fetchFn = erroringStreamOnce(
      nativeFetch,
      "ranged/coalesce-3.bin",
      [data.slice(0, CHUNK_SIZE), data.slice(CHUNK_SIZE, CHUNK_SIZE * 2)],
      "connection reset",
    );

    const transfer = makeCoalesceTransfer({ key: "ranged/coalesce-3.bin", localPath: freshLocalPath("c3.bin") });
    const { writer, writeAtCalls, discarded } = trackedWriter();
    const store = new MemoryTransferStore();

    await expect(
      downloadTransfer(transfer, {
        client: clientWith(fetchFn),
        bucket: bucket.name,
        writer,
        reader: localFileReader,
        store,
        connections: 2,
      }),
    ).rejects.toThrow("connection reset");

    // The buffered bytes from before the error were never flushed (under the
    // 2 MiB window), and the part must not be recorded as complete.
    expect(writeAtCalls).toHaveLength(0);
    const parts = await store.listParts(transfer.id);
    expect(parts).toHaveLength(0);
    expect(await fileExists(transfer.localPath)).toBe(false);
    // Temp file is kept for resume (as with any other mid-download error).
    expect(discarded).toHaveLength(0);
  });
});
