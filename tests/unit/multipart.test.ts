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
  MULTIPART_THRESHOLD,
  PART_SIZE,
  VerificationError,
  uploadTransfer,
  type LocalFileReader,
} from "../../src/lib/s3/multipart";
import { md5Hex, compositeEtag } from "../../src/lib/md5";
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

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: overrides.id ?? "transfer-1",
    connectionId: "conn-1",
    key: "path/to/file.bin",
    localPath: "/local/file.bin",
    size: 10,
    partSize: PART_SIZE,
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

describe("uploadTransfer — single-part path (< 16 MiB)", () => {
  test("happy path: PutObject ETag matches local MD5 → resolves", async () => {
    const body = new TextEncoder().encode("hello world");
    const reader = makeReader(body);
    const expectedMd5 = md5Hex(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(expectedMd5) });

    const transfer = makeTransfer({ size: body.length });
    const store = new MemoryTransferStore();

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store }),
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
    const store = new MemoryTransferStore();

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  test("reports progress while reading chunks", async () => {
    const body = new Uint8Array(1000).fill(7);
    const reader = makeReader(body);
    s3Mock.on(PutObjectCommand).resolves({ ETag: q(md5Hex(body)) });

    const transfer = makeTransfer({ size: body.length });
    const store = new MemoryTransferStore();
    const progressCalls: Array<[number, number]> = [];

    await uploadTransfer(transfer, {
      client,
      bucket: "b",
      reader,
      store,
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    });

    expect(progressCalls.length).toBeGreaterThan(0);
    expect(progressCalls[progressCalls.length - 1]).toEqual([1000, 1000]);
  });
});

describe("uploadTransfer — multipart path (>= 16 MiB)", () => {
  function bigBody(size: number): Uint8Array {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = i % 251;
    return b;
  }

  test("happy path: creates upload, uploads parts, completes, verifies", async () => {
    const size = MULTIPART_THRESHOLD + PART_SIZE + 1234; // 3 parts
    const body = bigBody(size);
    const reader = makeReader(body);
    const store = new MemoryTransferStore();
    const transfer = makeTransfer({ size, id: "mp-1" });

    const partCount = Math.ceil(size / PART_SIZE);
    const partHexes: string[] = [];
    for (let i = 0; i < partCount; i++) {
      const offset = i * PART_SIZE;
      const len = Math.min(PART_SIZE, size - offset);
      partHexes.push(md5Hex(body.slice(offset, offset + len)));
    }

    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-abc" });
    s3Mock.on(ListPartsCommand).resolves({ Parts: [] });
    let callIndex = 0;
    s3Mock.on(UploadPartCommand).callsFake((input) => {
      const partNumber = input.PartNumber as number;
      return Promise.resolve({ ETag: q(partHexes[partNumber - 1]) });
    });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: size,
      ETag: q(compositeEtag(partHexes)),
    });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store }),
    ).resolves.toBeUndefined();

    const uploadCalls = s3Mock.commandCalls(UploadPartCommand);
    expect(uploadCalls).toHaveLength(partCount);

    // Every part must have been persisted incrementally.
    const persisted = await store.listParts("mp-1");
    expect(persisted).toHaveLength(partCount);
    expect(persisted.map((p) => p.partNumber)).toEqual(
      Array.from({ length: partCount }, (_, i) => i + 1),
    );

    // uploadId persisted immediately (before completion).
    const savedTransfer = await store.get("mp-1");
    expect(savedTransfer?.uploadId).toBe("upload-abc");
  });

  test("resume after simulated restart uploads only missing parts", async () => {
    const size = MULTIPART_THRESHOLD + PART_SIZE; // 3 parts (16+8=24 MiB / 8 MiB parts)
    const body = bigBody(size);
    const reader = makeReader(body);
    const partCount = Math.ceil(size / PART_SIZE);
    const partHexes: string[] = [];
    for (let i = 0; i < partCount; i++) {
      const offset = i * PART_SIZE;
      const len = Math.min(PART_SIZE, size - offset);
      partHexes.push(md5Hex(body.slice(offset, offset + len)));
    }

    // --- "First run": crash after part 1 completes. ---
    const store = new MemoryTransferStore();
    const transfer = makeTransfer({ size, id: "mp-resume", uploadId: "upload-xyz" });
    await store.save(transfer);
    await store.saveParts([
      { transferId: "mp-resume", partNumber: 1, etag: q(partHexes[0]), size: PART_SIZE },
    ]);

    // Server truth confirms part 1 is there (simulating what really landed).
    s3Mock.on(ListPartsCommand).resolves({
      Parts: [{ PartNumber: 1, ETag: q(partHexes[0]), Size: PART_SIZE }],
    });
    s3Mock.on(UploadPartCommand).callsFake((input) => {
      const partNumber = input.PartNumber as number;
      return Promise.resolve({ ETag: q(partHexes[partNumber - 1]) });
    });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: size,
      ETag: q(compositeEtag(partHexes)),
    });

    // --- "Restart": rebuild from the same store, resume. ---
    const resumedTransfer = (await store.get("mp-resume"))!;
    await uploadTransfer(resumedTransfer, { client, bucket: "b", reader, store });

    // CreateMultipartUpload must NOT be called again (uploadId already existed).
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0);

    // Only the two missing parts (2 and 3) should have been uploaded.
    const uploadCalls = s3Mock.commandCalls(UploadPartCommand);
    expect(uploadCalls).toHaveLength(partCount - 1);
    const uploadedPartNumbers = uploadCalls
      .map((c) => c.args[0].input.PartNumber)
      .sort();
    expect(uploadedPartNumbers).toEqual([2, 3]);

    const persisted = await store.listParts("mp-resume");
    expect(persisted).toHaveLength(partCount);
  });

  test("truncated upload (HeadObject returns short size) → failed verification, never uploaded", async () => {
    const size = MULTIPART_THRESHOLD + 100;
    const body = bigBody(size);
    const reader = makeReader(body);
    const store = new MemoryTransferStore();
    const transfer = makeTransfer({ size, id: "mp-truncated" });

    const partCount = Math.ceil(size / PART_SIZE);
    const partHexes: string[] = [];
    for (let i = 0; i < partCount; i++) {
      const offset = i * PART_SIZE;
      const len = Math.min(PART_SIZE, size - offset);
      partHexes.push(md5Hex(body.slice(offset, offset + len)));
    }

    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-trunc" });
    s3Mock.on(ListPartsCommand).resolves({ Parts: [] });
    s3Mock.on(UploadPartCommand).callsFake((input) => {
      const partNumber = input.PartNumber as number;
      return Promise.resolve({ ETag: q(partHexes[partNumber - 1]) });
    });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    // Server reports a size smaller than what was actually sent — simulates
    // a truncated transfer that still returned success from the SDK.
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: size - 50,
      ETag: q(compositeEtag(partHexes)),
    });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store }),
    ).rejects.toBeInstanceOf(VerificationError);
  });

  test("composite ETag mismatch → failed verification", async () => {
    const size = MULTIPART_THRESHOLD + 100;
    const body = bigBody(size);
    const reader = makeReader(body);
    const store = new MemoryTransferStore();
    const transfer = makeTransfer({ size, id: "mp-etag-mismatch" });

    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-em" });
    s3Mock.on(ListPartsCommand).resolves({ Parts: [] });
    s3Mock.on(UploadPartCommand).resolves({ ETag: q("a".repeat(32)) });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({
      ContentLength: size,
      ETag: q("wrong-composite-etag-000000000000-2"),
    });

    await expect(
      uploadTransfer(transfer, { client, bucket: "b", reader, store }),
    ).rejects.toBeInstanceOf(VerificationError);
  });
});
