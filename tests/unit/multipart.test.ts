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
  PART_SIZE,
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "../../src/lib/s3/multipart";
import { md5Hex, bytesToHex, compositeEtag } from "../../src/lib/md5";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";

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

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: "transfer-1",
    connectionId: "conn-1",
    key: "path/to/file.bin",
    localPath: "/local/file.bin",
    size: 10,
    partSize: PART_SIZE,
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

describe("uploadTransfer — single-part (ETag/MD5) verification", () => {
  test("happy path: ETag matches local MD5 → resolves", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    const expectedMd5 = await md5Hex(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(expectedMd5) });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store: new MemoryTransferStore() }),
    ).resolves.toBeUndefined();
  });

  test("ETag mismatch → VerificationError", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q("f".repeat(32)) });

    const transfer = makeTransfer({ size: body.length });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store: new MemoryTransferStore() }),
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
      store: new MemoryTransferStore(),
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });
});

describe("uploadTransfer — multipart", () => {
  const partSize = 8 * 1024 * 1024;
  const body = new Uint8Array(partSize * 2 + 1).fill(42); // 16MB+1 > MULTIPART_THRESHOLD

  test("creates upload, uploads parts, completes, and verifies composite ETag", async () => {
    const partEtag = "d41d8cd98f00b204e9800998ecf8427e";
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-123" });
    s3Mock.on(ListPartsCommand).resolves({ Parts: [] });
    s3Mock.on(UploadPartCommand).resolves({ ETag: q(partEtag) });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const composite = await compositeEtag([partEtag, partEtag, partEtag]);
    s3Mock.on(HeadObjectCommand).resolves({
      ETag: q(composite),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-1",
      size: body.length,
      partSize,
    });

    await uploadTransfer(transfer, {
      client,
      bucket: "b",
      reader: makeReader(body),
      store,
    });

    const parts = await store.listParts("multi-1");
    expect(parts.length).toBe(3);
  });

  test("skips already-uploaded parts (server truth)", async () => {
    const serverEtag = "ab56b4d92b40713acc5af89985d4b786";
    const newEtag = "d41d8cd98f00b204e9800998ecf8427e";
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-456" });
    s3Mock.on(ListPartsCommand).resolves({
      Parts: [
        { PartNumber: 1, ETag: q(serverEtag), Size: partSize },
      ],
    });
    s3Mock.on(UploadPartCommand).resolves({ ETag: q(newEtag) });
    const composite = await compositeEtag([serverEtag, newEtag, newEtag]);
    s3Mock.on(HeadObjectCommand).resolves({
      ETag: q(composite),
      ContentLength: body.length,
    });

    const store = new MemoryTransferStore();
    const transfer = makeTransfer({
      id: "multi-skip",
      size: body.length,
      partSize,
    });

    await expect(
      uploadTransfer(transfer, {
        client,
        bucket: "b",
        reader: makeReader(body),
        store,
      }),
    ).resolves.toBeUndefined();
  });
});