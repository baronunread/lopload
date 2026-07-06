import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { sweepTrash } from "../../src/lib/s3/trashSweep";
import { trashKey } from "../../src/lib/s3/trash";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 30 * DAY;

beforeEach(() => {
  s3Mock.reset();
});

describe("sweepTrash", () => {
  test("purges only entries older than the retention window", async () => {
    const now = Date.now();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: trashKey(now - 40 * DAY, "old-file.txt") },
        { Key: trashKey(now - 1 * DAY, "recent-file.txt") },
      ],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const stats = await sweepTrash(client, "my-bucket", now, RETENTION);

    expect(stats.scanned).toBe(2);
    expect(stats.purged).toBe(1);
    expect(stats.errors).toBe(0);

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toEqual([
      { Key: trashKey(now - 40 * DAY, "old-file.txt") },
    ]);
  });

  test("ignores keys that aren't shaped like trash entries", async () => {
    const now = Date.now();
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: ".lopload-trash/not-a-timestamp/file.txt" }],
      IsTruncated: false,
    });

    const stats = await sweepTrash(client, "my-bucket", now, RETENTION);
    expect(stats.purged).toBe(0);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  test("paginates via ContinuationToken", async () => {
    const now = Date.now();
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: trashKey(now - 40 * DAY, "a.txt") }],
        IsTruncated: true,
        NextContinuationToken: "page-2",
      })
      .resolvesOnce({
        Contents: [{ Key: trashKey(now - 40 * DAY, "b.txt") }],
        IsTruncated: false,
      });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const stats = await sweepTrash(client, "my-bucket", now, RETENTION);
    expect(stats.scanned).toBe(2);
    expect(stats.purged).toBe(2);
  });

  test("batches deletes in groups of 1000", async () => {
    const now = Date.now();
    const contents = Array.from({ length: 1500 }, (_, i) => ({
      Key: trashKey(now - 40 * DAY, `file-${i}.txt`),
    }));
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: contents, IsTruncated: false });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const stats = await sweepTrash(client, "my-bucket", now, RETENTION);
    expect(stats.purged).toBe(1500);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(2);
  });

  test("swallows errors from ListObjectsV2 and never throws", async () => {
    const now = Date.now();
    s3Mock.on(ListObjectsV2Command).rejects(new Error("network down"));

    const stats = await sweepTrash(client, "my-bucket", now, RETENTION);
    expect(stats.errors).toBeGreaterThan(0);
    expect(stats.purged).toBe(0);
  });

  test("swallows errors from an individual DeleteObjects batch and continues", async () => {
    const now = Date.now();
    const contents = Array.from({ length: 1500 }, (_, i) => ({
      Key: trashKey(now - 40 * DAY, `file-${i}.txt`),
    }));
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: contents, IsTruncated: false });
    s3Mock.on(DeleteObjectsCommand).rejectsOnce(new Error("batch failed")).resolves({});

    const stats = await sweepTrash(client, "my-bucket", now, RETENTION);
    expect(stats.errors).toBe(1);
    expect(stats.purged).toBe(500);
  });
});
