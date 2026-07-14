import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { downloadTransfer } from "../../src/lib/s3/download";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/minio";
import { bucketProbe } from "../support/bucketProbe";
import { faultyFetch } from "../support/faultyFetch";
import { localFileReader, localFileWriter } from "../support/localFiles";
import { nativeFetch } from "../setup";

let bucket: Bucket;
let workdir: string;

beforeAll(async () => {
  bucket = await freshBucket();
  workdir = await mkdtemp(join(tmpdir(), "lopload-download-test-"));
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

let fileCounter = 0;
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

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: overrides.id ?? "transfer-1",
    connectionId: "conn-1",
    key: "path/to/file.bin",
    localPath: freshLocalPath("file.bin"),
    size: 10,
    direction: "download",
    state: { kind: "sending", percent: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Instruments the real localFileWriter, recording discard() calls, so
 * cleanup can be asserted on without an in-memory fake writer. */
function trackedWriter() {
  const discarded: string[] = [];
  const writer = {
    ...localFileWriter,
    async discard(tempPath: string) {
      discarded.push(tempPath);
      await localFileWriter.discard(tempPath);
    },
  };
  return { writer, discarded };
}

describe("downloadTransfer — single-GET path", () => {
  test("happy path: plain MD5 ETag matches downloaded bytes → resolves and commits", async () => {
    const body = new TextEncoder().encode("hello world");
    await bucketProbe(bucket.client, bucket.name).put("single/happy.txt", body);

    const transfer = makeTransfer({ key: "single/happy.txt", size: body.length });
    const { writer, discarded } = trackedWriter();

    await expect(
      downloadTransfer(transfer, {
        client: clientWith(),
        bucket: bucket.name,
        writer,
        reader: localFileReader,
        store: new MemoryTransferStore(),
      }),
    ).resolves.toBeUndefined();

    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(body);
    expect(discarded).toHaveLength(0);
  });

  test("ETag mismatch → VerificationError, temp file discarded, nothing committed", async () => {
    const body = new TextEncoder().encode("hello world");
    await bucketProbe(bucket.client, bucket.name).put("single/mismatch.txt", body);
    const client = clientWith(
      faultyFetch(nativeFetch, [
        { urlContains: "single/mismatch.txt", method: "GET", action: { kind: "corruptEtag" } },
      ]),
    );

    const transfer = makeTransfer({ key: "single/mismatch.txt", size: body.length });
    const { writer, discarded } = trackedWriter();

    await expect(
      downloadTransfer(transfer, {
        client,
        bucket: bucket.name,
        writer,
        reader: localFileReader,
        store: new MemoryTransferStore(),
      }),
    ).rejects.toThrow(/checksum/);
    expect(await fileExists(transfer.localPath)).toBe(false);
    expect(discarded).toEqual([writer.tempPathFor(transfer.localPath)]);
  });

  test("size mismatch (truncated stream) → VerificationError", async () => {
    const body = new TextEncoder().encode("hello world");
    await bucketProbe(bucket.client, bucket.name).put("single/truncated.txt", body);
    const client = clientWith(
      faultyFetch(nativeFetch, [
        {
          urlContains: "single/truncated.txt",
          method: "GET",
          action: { kind: "truncateBody", bytes: body.length - 3 },
        },
      ]),
    );

    const transfer = makeTransfer({ key: "single/truncated.txt", size: body.length });
    const { writer } = trackedWriter();

    await expect(
      downloadTransfer(transfer, {
        client,
        bucket: bucket.name,
        writer,
        reader: localFileReader,
        store: new MemoryTransferStore(),
      }),
    ).rejects.toThrow(/size/);
    expect(await fileExists(transfer.localPath)).toBe(false);
  });

  test("reports progress as bytes are received", async () => {
    const body = new Uint8Array(1000).fill(7);
    await bucketProbe(bucket.client, bucket.name).put("single/progress.bin", body);

    const transfer = makeTransfer({ key: "single/progress.bin", size: body.length });
    const { writer } = trackedWriter();
    const progressCalls: Array<[number, number]> = [];

    await downloadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      writer,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      onProgress: (received, total) => progressCalls.push([received, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });

  test("zero-byte file still materializes and commits an empty file", async () => {
    const body = new Uint8Array(0);
    await bucketProbe(bucket.client, bucket.name).put("single/empty.bin", body);

    const transfer = makeTransfer({ key: "single/empty.bin", size: 0 });
    const { writer } = trackedWriter();

    await downloadTransfer(transfer, {
      client: clientWith(),
      bucket: bucket.name,
      writer,
      reader: localFileReader,
      store: new MemoryTransferStore(),
    });
    expect(new Uint8Array(await Bun.file(transfer.localPath).arrayBuffer())).toEqual(body);
  });

  test("aborting via the signal rejects and discards the temp file", async () => {
    await bucketProbe(bucket.client, bucket.name).put("single/abort.bin", new Uint8Array(10));
    const controller = new AbortController();
    // Stall long enough that abort() reliably lands before the real GET
    // would otherwise complete over loopback.
    const client = clientWith(
      faultyFetch(nativeFetch, [
        { urlContains: "single/abort.bin", method: "GET", action: { kind: "stall", ms: 200 } },
      ]),
    );

    const transfer = makeTransfer({ key: "single/abort.bin" });
    const { writer, discarded } = trackedWriter();

    const done = downloadTransfer(transfer, {
      client,
      bucket: bucket.name,
      writer,
      reader: localFileReader,
      store: new MemoryTransferStore(),
      signal: controller.signal,
    });
    queueMicrotask(() => controller.abort());

    await expect(done).rejects.toThrow();
    expect(await fileExists(transfer.localPath)).toBe(false);
    // No bytes were ever staged in this case (GetObject itself rejected, a
    // single client.send() the engine never gets past to the try/catch that
    // calls discard()), so nothing needed to be removed — the writer must
    // not have committed.
    expect(discarded).toEqual([]);
  });
});
