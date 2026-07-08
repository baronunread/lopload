import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createCRC32 } from "hash-wasm";

import {
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "../../src/lib/s3/multipart";
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

async function crc32Base64(bytes: Uint8Array): Promise<string> {
  const h = await createCRC32();
  h.init();
  h.update(bytes);
  const raw = h.digest("binary") as Uint8Array;
  return btoa(String.fromCharCode(...raw));
}

describe("uploadTransfer — CRC32 verification", () => {
  test("happy path: ChecksumCRC32 matches local CRC32 → resolves", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    const expectedCrc32 = await crc32Base64(body);
    s3Mock.on(PutObjectCommand).resolves({ ChecksumCRC32: expectedCrc32 });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader }),
    ).resolves.toBeUndefined();
  });

  test("ChecksumCRC32 mismatch → VerificationError", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ChecksumCRC32: "AAAAAA==" });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  test("reports progress while reading chunks", async () => {
    const body = new Uint8Array(1000).fill(7);
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ChecksumCRC32: await crc32Base64(body) });

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
