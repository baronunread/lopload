import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

import {
  downloadTransfer,
  type LocalFileWriter,
} from "../../src/lib/s3/download";
import { md5Hex } from "../../src/lib/md5";
import type { Transfer } from "../../src/lib/types";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

beforeEach(() => {
  s3Mock.reset();
});

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: overrides.id ?? "transfer-1",
    connectionId: "conn-1",
    key: "path/to/file.bin",
    localPath: "/local/dest/file.bin",
    size: 10,
    direction: "download",
    state: { kind: "sending", percent: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function q(hex: string): string {
  return `"${hex}"`;
}

/** In-memory fake writer recording exactly what would land on disk, so tests
 * can assert on temp-file staging + commit/discard without touching the
 * filesystem. */
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

describe("downloadTransfer — single-GET path", () => {
  test("happy path: plain MD5 ETag matches downloaded bytes → resolves and commits", async () => {
    const body = new TextEncoder().encode("hello world");
    const expectedMd5 = md5Hex(body);
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q(expectedMd5),
      ContentLength: body.length,
    });

    const transfer = makeTransfer({ size: body.length });
    const { writer, committed, discarded } = makeWriter();

    await expect(
      downloadTransfer(transfer, { client, bucket: "b", writer }),
    ).resolves.toBeUndefined();

    expect(committed.get(transfer.localPath)).toEqual(body);
    expect(discarded).toHaveLength(0);
  });

  test("ETag mismatch → VerificationError, temp file discarded, nothing committed", async () => {
    const body = new TextEncoder().encode("hello world");
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q("0".repeat(32)),
      ContentLength: body.length,
    });

    const transfer = makeTransfer({ size: body.length });
    const { writer, committed, discarded } = makeWriter();

    await expect(
      downloadTransfer(transfer, { client, bucket: "b", writer }),
    ).rejects.toThrow(/checksum/);
    expect(committed.size).toBe(0);
    expect(discarded).toEqual([`${transfer.localPath}.tmp`]);
  });

  test("size mismatch (truncated stream) → VerificationError", async () => {
    const body = new TextEncoder().encode("hello world");
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q("deadbeefdeadbeefdeadbeefdeadbeef"),
      ContentLength: body.length + 5,
    });

    const transfer = makeTransfer({ size: body.length + 5 });
    const { writer, committed } = makeWriter();

    await expect(
      downloadTransfer(transfer, { client, bucket: "b", writer }),
    ).rejects.toThrow(/size/);
    expect(committed.size).toBe(0);
  });

  test("reports progress as bytes are received", async () => {
    const body = new Uint8Array(1000).fill(7);
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q(md5Hex(body)),
      ContentLength: body.length,
    });

    const transfer = makeTransfer({ size: body.length });
    const { writer } = makeWriter();
    const progressCalls: Array<[number, number]> = [];

    await downloadTransfer(transfer, {
      client,
      bucket: "b",
      writer,
      onProgress: (received, total) => progressCalls.push([received, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });

  test("zero-byte file still materializes and commits an empty file", async () => {
    const body = new Uint8Array(0);
    s3Mock.on(GetObjectCommand).resolves({
      Body: bodyStreamOf(body) as never,
      ETag: q(md5Hex(body)),
      ContentLength: 0,
    });

    const transfer = makeTransfer({ size: 0 });
    const { writer, committed } = makeWriter();

    await downloadTransfer(transfer, { client, bucket: "b", writer });
    expect(committed.get(transfer.localPath)).toEqual(body);
  });

  test("aborting via the signal rejects and discards the temp file", async () => {
    const controller = new AbortController();
    s3Mock.on(GetObjectCommand).callsFake(() => {
      controller.abort();
      const err = new Error("Request aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const transfer = makeTransfer();
    const { writer, committed, discarded } = makeWriter();

    await expect(
      downloadTransfer(transfer, { client, bucket: "b", writer, signal: controller.signal }),
    ).rejects.toThrow();
    expect(committed.size).toBe(0);
    // No bytes were ever staged in this case (GetObject itself rejected),
    // so nothing needed to be removed — the writer must not have committed.
    expect(discarded).toEqual([]);
  });
});
