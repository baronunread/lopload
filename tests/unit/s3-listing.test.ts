import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  copyLink,
  createFolder,
  createS3Client,
  deleteFile,
  listEntries,
  testConnection,
} from "../../src/lib/s3/client";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
});
const s3Mock = mockClient(client);

beforeEach(() => {
  s3Mock.reset();
});

describe("createS3Client", () => {
  test("uses forcePathStyle and the injected fetch", () => {
    const fetchFn = (async () => new Response("")) as typeof fetch;
    const c = createS3Client(
      { endpoint: "https://example.test", region: "us-east-1" },
      { accessKey: "ak", secretKey: "sk" },
      fetchFn,
    );
    expect(c.config.forcePathStyle).toBe(true);
  });
});

describe("listEntries", () => {
  test("synthesizes folders from CommonPrefixes with no trailing slash", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: "videos/" }, { Prefix: "docs/" }],
      Contents: [
        { Key: "readme.txt", Size: 12, LastModified: new Date(1000) },
        // The zero-byte folder marker for the prefix itself must not appear as a file.
        { Key: "", Size: 0 },
      ],
      IsTruncated: false,
    });

    const entries = await listEntries(client, "my-bucket", "");

    const folders = entries.filter((e) => e.kind === "folder");
    expect(folders.map((f) => f.name)).toEqual(["videos", "docs"]);
    for (const f of folders) {
      expect(f.name.endsWith("/")).toBe(false);
      expect(f.key.endsWith("/")).toBe(true);
    }

    const files = entries.filter((e) => e.kind === "file");
    expect(files).toEqual([
      { kind: "file", name: "readme.txt", key: "readme.txt", size: 12, lastModified: 1000 },
    ]);
  });

  test("nested folder name strips full prefix path, not just trailing slash", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      CommonPrefixes: [{ Prefix: "videos/2024/" }],
      Contents: [],
      IsTruncated: false,
    });
    const entries = await listEntries(client, "my-bucket", "videos/");
    expect(entries).toEqual([
      { kind: "folder", name: "2024", key: "videos/2024/" },
    ]);
  });

  test("paginates via ContinuationToken", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: "a.txt", Size: 1 }],
        IsTruncated: true,
        NextContinuationToken: "token-2",
      })
      .resolvesOnce({
        Contents: [{ Key: "b.txt", Size: 2 }],
        IsTruncated: false,
      });

    const entries = await listEntries(client, "my-bucket", "");
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("createFolder", () => {
  test("creates a zero-byte key ending in /", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await createFolder(client, "my-bucket", "new-folder");
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toBe("new-folder/");
    expect(calls[0].args[0].input.Body).toEqual(new Uint8Array(0));
  });
});

describe("deleteFile", () => {
  test("issues a DeleteObjectCommand for the given key", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await deleteFile(client, "my-bucket", "a/b.txt");
    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls[0].args[0].input).toEqual({ Bucket: "my-bucket", Key: "a/b.txt" });
  });
});

describe("copyLink", () => {
  test("returns a presigned GET URL", async () => {
    const url = await copyLink(client, "my-bucket", "a/b.txt");
    expect(url).toContain("a/b.txt");
    expect(url).toContain("X-Amz-Expires=");
    const expiresMatch = url.match(/X-Amz-Expires=(\d+)/);
    expect(expiresMatch?.[1]).toBe(String(7 * 24 * 60 * 60));
  });
});

describe("testConnection", () => {
  test("small write + read + delete succeeds", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(HeadObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await testConnection(client, "my-bucket");
    expect(result.ok).toBe(true);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  test("failure returns a PlainError, never throws", async () => {
    s3Mock.on(PutObjectCommand).rejects({ name: "AccessDenied" });
    s3Mock.on(DeleteObjectCommand).resolves({});

    const result = await testConnection(client, "my-bucket");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("credentials");
      expect(result.error.message).not.toContain("AccessDenied");
    }
  });
});
