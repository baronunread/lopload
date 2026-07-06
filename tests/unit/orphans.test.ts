import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { sweepOrphans } from "../../src/lib/s3/orphans";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

const DAY = 24 * 60 * 60 * 1000;
const MAX_AGE = 3 * DAY;

beforeEach(() => {
  s3Mock.reset();
});

function transferWithUpload(id: string, uploadId: string): Transfer {
  const now = Date.now();
  return {
    id,
    connectionId: "conn-1",
    key: `k-${id}`,
    localPath: `/local/${id}`,
    size: 100,
    partSize: 8 * 1024 * 1024,
    uploadId,
    direction: "upload",
    state: { kind: "sending", percent: 10 },
    createdAt: now,
    updatedAt: now,
  };
}

describe("sweepOrphans", () => {
  test("aborts only sessions that are both old and untracked", async () => {
    const now = Date.now();
    const store = new MemoryTransferStore();
    // Tracked session, old — must NOT be aborted (still actively retryable/known).
    await store.save(transferWithUpload("t-tracked-old", "upload-tracked-old"));

    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [
        {
          Key: "k-tracked-old",
          UploadId: "upload-tracked-old",
          Initiated: new Date(now - 10 * DAY),
        },
        {
          Key: "k-orphan-old",
          UploadId: "upload-orphan-old",
          Initiated: new Date(now - 10 * DAY),
        },
        {
          Key: "k-orphan-young",
          UploadId: "upload-orphan-young",
          Initiated: new Date(now - 1 * DAY),
        },
      ],
      IsTruncated: false,
    });
    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    const stats = await sweepOrphans(client, store, "conn-1", "my-bucket", now, MAX_AGE);

    expect(stats.scanned).toBe(3);
    expect(stats.aborted).toBe(1);
    expect(stats.errors).toBe(0);

    const abortCalls = s3Mock.commandCalls(AbortMultipartUploadCommand);
    expect(abortCalls).toHaveLength(1);
    expect(abortCalls[0].args[0].input.UploadId).toBe("upload-orphan-old");
  });

  test("young untracked sessions are left alone", async () => {
    const now = Date.now();
    const store = new MemoryTransferStore();

    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [
        { Key: "k1", UploadId: "u1", Initiated: new Date(now - DAY) },
      ],
      IsTruncated: false,
    });

    const stats = await sweepOrphans(client, store, "conn-1", "my-bucket", now, MAX_AGE);
    expect(stats.aborted).toBe(0);
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0);
  });

  test("tracked young sessions are left alone", async () => {
    const now = Date.now();
    const store = new MemoryTransferStore();
    await store.save(transferWithUpload("t1", "u1"));

    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [{ Key: "k-t1", UploadId: "u1", Initiated: new Date(now - DAY) }],
      IsTruncated: false,
    });

    const stats = await sweepOrphans(client, store, "conn-1", "my-bucket", now, MAX_AGE);
    expect(stats.aborted).toBe(0);
  });

  test("paginates via KeyMarker/UploadIdMarker", async () => {
    const now = Date.now();
    const store = new MemoryTransferStore();

    s3Mock
      .on(ListMultipartUploadsCommand)
      .resolvesOnce({
        Uploads: [{ Key: "k1", UploadId: "u1", Initiated: new Date(now - 10 * DAY) }],
        IsTruncated: true,
        NextKeyMarker: "k1",
        NextUploadIdMarker: "u1",
      })
      .resolvesOnce({
        Uploads: [{ Key: "k2", UploadId: "u2", Initiated: new Date(now - 10 * DAY) }],
        IsTruncated: false,
      });
    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    const stats = await sweepOrphans(client, store, "conn-1", "my-bucket", now, MAX_AGE);
    expect(stats.scanned).toBe(2);
    expect(stats.aborted).toBe(2);
  });

  test("swallows errors from ListMultipartUploads and never throws", async () => {
    const now = Date.now();
    const store = new MemoryTransferStore();
    s3Mock.on(ListMultipartUploadsCommand).rejects(new Error("network down"));

    const stats = await sweepOrphans(client, store, "conn-1", "my-bucket", now, MAX_AGE);
    expect(stats.errors).toBeGreaterThan(0);
    expect(stats.aborted).toBe(0);
  });

  test("swallows errors from an individual AbortMultipartUpload and continues", async () => {
    const now = Date.now();
    const store = new MemoryTransferStore();

    s3Mock.on(ListMultipartUploadsCommand).resolves({
      Uploads: [
        { Key: "k1", UploadId: "u1", Initiated: new Date(now - 10 * DAY) },
        { Key: "k2", UploadId: "u2", Initiated: new Date(now - 10 * DAY) },
      ],
      IsTruncated: false,
    });
    s3Mock
      .on(AbortMultipartUploadCommand)
      .rejectsOnce(new Error("abort failed"))
      .resolves({});

    const stats = await sweepOrphans(client, store, "conn-1", "my-bucket", now, MAX_AGE);
    expect(stats.scanned).toBe(2);
    expect(stats.aborted).toBe(1);
    expect(stats.errors).toBe(1);
  });
});
