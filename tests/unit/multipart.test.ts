import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "../../src/lib/s3/multipart";
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
    localPath: "/local/file.bin",
    size: 10,
    direction: "upload",
    state: { kind: "sending", percent: 0 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** In-memory fake file whose bytes are deterministic given its size. */
function makeReader(bytes: Uint8Array): LocalFileReader {
  return {
    async size() {
      return bytes.length;
    },
    async readChunk(_path, offset, length) {
      return bytes.slice(offset, offset + length);
    },
  };
}

function q(hex: string): string {
  return `"${hex}"`;
}

describe("uploadTransfer — single-part upload", () => {
  test("happy path: PutObject ETag matches local MD5 → resolves", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    const expectedMd5 = await md5Hex(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(expectedMd5) });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader }),
    ).resolves.toBeUndefined();

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toBe(transfer.key);
  });

  test("ETag mismatch → VerificationError, never resolves as success", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q("0".repeat(32)) });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  test("reports progress while reading chunks", async () => {
    const body = new Uint8Array(1000).fill(7);
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(await md5Hex(body)) });

    const transfer = makeTransfer({ size: body.length });
    const progressCalls: Array<[number, number]> = [];

    await uploadTransfer(transfer, {
      client,
      bucket: "b",
      reader,
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });
});
