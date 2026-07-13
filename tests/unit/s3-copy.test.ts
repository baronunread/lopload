import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";

import {
  COPY_MULTIPART_THRESHOLD,
  COPY_PART_SIZE,
  renameFolder,
  type CopyProgress,
} from "../../src/lib/s3/client";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

beforeEach(() => {
  s3Mock.reset();
});

/** A folder of `count` objects each `size` bytes, as ListObjectsV2 would report it. */
function folderOf(count: number, size: number) {
  return {
    Contents: Array.from({ length: count }, (_, i) => ({
      Key: `Videos/clip-${i}.mov`,
      Size: size,
    })),
  };
}

const GB = 1024 * 1024 * 1024;

describe("renameFolder progress", () => {
  test("reports progress while a big-file copy is still running, not only at the end", async () => {
    // The bug: a folder of a few huge files sat at 0% for minutes and then
    // snapped straight to 100%, because every copy was awaited as one batch
    // and progress counted whole objects.
    s3Mock.on(ListObjectsV2Command).resolves(folderOf(3, 2 * GB));
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-1" });
    s3Mock.on(UploadPartCopyCommand).resolves({ CopyPartResult: { ETag: '"etag"' } });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const seen: CopyProgress[] = [];
    await renameFolder(client, "my-bucket", "Videos/", "Archive/", (p) => seen.push({ ...p }));

    const percent = (p: CopyProgress) => Math.floor((p.copiedBytes / p.totalBytes) * 100);
    const midway = seen.filter((p) => percent(p) > 0 && percent(p) < 100);
    expect(midway.length).toBeGreaterThan(10);

    // Progress only ever moves forward, and lands exactly on the total.
    const bytes = seen.map((p) => p.copiedBytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    const last = seen.at(-1)!;
    expect(last.copiedBytes).toBe(last.totalBytes);
    expect(last.copiedItems).toBe(3);
    expect(last.totalItems).toBe(3);
  });

  test("copies a large object in parts, so it is not capped at CopyObject's 5 GB limit", async () => {
    const size = 6 * GB; // a single CopyObject would be rejected outright
    s3Mock.on(ListObjectsV2Command).resolves(folderOf(1, size));
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-1" });
    s3Mock.on(UploadPartCopyCommand).resolves({ CopyPartResult: { ETag: '"etag"' } });
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await renameFolder(client, "my-bucket", "Videos/", "Archive/");

    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    const parts = s3Mock.commandCalls(UploadPartCopyCommand);
    expect(parts).toHaveLength(Math.ceil(size / COPY_PART_SIZE));

    // Every byte of the source is covered exactly once, by contiguous ranges.
    const ranges = parts
      .map((c) => c.args[0].input)
      .map((input) => ({
        part: input.PartNumber!,
        range: input.CopySourceRange!,
      }))
      .sort((a, b) => a.part - b.part);
    let expectedStart = 0;
    for (const { range } of ranges) {
      const [start, end] = range.replace("bytes=", "").split("-").map(Number);
      expect(start).toBe(expectedStart);
      expectedStart = end + 1;
    }
    expect(expectedStart).toBe(size);

    const completed = s3Mock.commandCalls(CompleteMultipartUploadCommand)[0].args[0].input;
    expect(completed.MultipartUpload?.Parts?.map((p) => p.PartNumber)).toEqual(
      ranges.map((r) => r.part),
    );
  });

  test("copies small objects in one shot rather than as multipart", async () => {
    s3Mock.on(ListObjectsV2Command).resolves(folderOf(2, COPY_MULTIPART_THRESHOLD - 1));
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await renameFolder(client, "my-bucket", "Videos/", "Archive/");

    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(2);
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0);
  });

  test("aborts the multipart upload and deletes nothing when a part copy fails", async () => {
    s3Mock.on(ListObjectsV2Command).resolves(folderOf(1, 2 * GB));
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "upload-1" });
    s3Mock.on(UploadPartCopyCommand).rejects(new Error("network died"));
    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    await expect(renameFolder(client, "my-bucket", "Videos/", "Archive/")).rejects.toThrow(
      "network died",
    );

    // A dangling multipart upload bills as storage until it's aborted, and the
    // originals must survive a copy that never completed.
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  test("falls back to item-weighted progress for a folder that is all empty markers", async () => {
    s3Mock.on(ListObjectsV2Command).resolves(folderOf(4, 0));
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    const seen: CopyProgress[] = [];
    await renameFolder(client, "my-bucket", "Videos/", "Archive/", (p) => seen.push({ ...p }));

    const last = seen.at(-1)!;
    expect(last.totalBytes).toBe(0); // nothing for a byte percentage to divide by
    expect(last.copiedItems).toBe(4);
    expect(last.totalItems).toBe(4);
  });
});
