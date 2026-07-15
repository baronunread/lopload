import { describe, expect, test, beforeAll } from "bun:test";

import {
  copyLink,
  createFolder,
  createS3Client,
  deleteFile,
  listEntries,
  testConnection,
} from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/storage";
import { bucketProbe } from "../support/bucketProbe";
import { faultyFetch } from "../support/faultyFetch";
import { nativeFetch } from "../setup";

let bucket: Bucket;

beforeAll(async () => {
  bucket = await freshBucket();
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

/** Runs `fn` over `items` with at most `limit` in flight — used to create
 * hundreds of real objects quickly without opening thousands of concurrent
 * sockets against local MinIO. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

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

  test("sets checksum config to WHEN_REQUIRED (R2/S3-compatible endpoints mishandle the default)", async () => {
    const fetchFn = (async () => new Response("")) as typeof fetch;
    const c = createS3Client(
      { endpoint: "https://example.test", region: "us-east-1" },
      { accessKey: "ak", secretKey: "sk" },
      fetchFn,
    );
    expect(await c.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await c.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
  });
});

describe("listEntries", () => {
  test("synthesizes folders from CommonPrefixes with no trailing slash", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    // "videos/" and "docs/" only become real CommonPrefixes once something
    // real lives under them — a bare zero-byte marker at the prefix itself
    // doesn't create a delimiter boundary the way a nested key does.
    await probe.put("list1/readme.txt", new Uint8Array(12));
    await probe.put("list1/videos/clip1.mov", new Uint8Array([1, 2, 3]));
    await probe.put("list1/docs/readme.md", new Uint8Array([1, 2, 3]));

    const entries = await listEntries(clientWith(), bucket.name, "list1/");

    const folders = entries.filter((e) => e.kind === "folder");
    expect(folders.map((f) => f.name).sort()).toEqual(["docs", "videos"]);
    for (const f of folders) {
      expect(f.name.endsWith("/")).toBe(false);
      expect(f.key.endsWith("/")).toBe(true);
    }

    const files = entries.filter((e) => e.kind === "file");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      kind: "file",
      name: "readme.txt",
      key: "list1/readme.txt",
      size: 12,
    });
    // lastModified is whatever MinIO really stamped the object with — a real
    // clock, not a value we can pin to an exact epoch the way the old mock did.
    expect(typeof (files[0] as { lastModified?: number }).lastModified).toBe("number");
  });

  test("nested folder name strips full prefix path, not just trailing slash", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    await probe.put("list2/videos/2024/photo.jpg", new Uint8Array([1]));

    const entries = await listEntries(clientWith(), bucket.name, "list2/videos/");
    expect(entries).toEqual([{ kind: "folder", name: "2024", key: "list2/videos/2024/" }]);
  });

  test("paginates via ContinuationToken", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    // Real ListObjectsV2 defaults to a 1000-key page — this forces a genuine
    // second page rather than asserting against a scripted mock response.
    const KEYS = 1200;
    const prefix = "list3/";
    await mapPool(
      Array.from({ length: KEYS }, (_, i) => i),
      100,
      (i) => probe.put(`${prefix}f${String(i).padStart(5, "0")}.txt`, new Uint8Array(0)),
    );

    const entries = await listEntries(clientWith(), bucket.name, prefix);
    expect(entries).toHaveLength(KEYS);
    expect(entries.every((e) => e.kind === "file")).toBe(true);
  }, 30_000);
});

describe("createFolder", () => {
  test("creates a zero-byte key ending in /", async () => {
    await createFolder(clientWith(), bucket.name, "listing/new-folder");

    const probe = bucketProbe(bucket.client, bucket.name);
    expect(await probe.get("listing/new-folder/")).toEqual(new Uint8Array(0));
  });
});

describe("deleteFile", () => {
  test("issues a DeleteObjectCommand for the given key", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    await probe.put("listing/a/b.txt", new Uint8Array([1, 2, 3]));

    await deleteFile(clientWith(), bucket.name, "listing/a/b.txt");

    expect(await probe.has("listing/a/b.txt")).toBe(false);
  });
});

describe("copyLink", () => {
  test("returns a presigned GET URL with the requested expiry", async () => {
    const url = await copyLink(clientWith(), bucket.name, "a/b.txt", 3600);
    expect(url).toContain("a/b.txt");
    expect(url).toContain("X-Amz-Expires=");
    const expiresMatch = url.match(/X-Amz-Expires=(\d+)/);
    expect(expiresMatch?.[1]).toBe("3600");
  });

  test("caps the expiry at SigV4's 7-day hard maximum", async () => {
    const url = await copyLink(clientWith(), bucket.name, "a/b.txt", 30 * 24 * 60 * 60);
    const expiresMatch = url.match(/X-Amz-Expires=(\d+)/);
    expect(expiresMatch?.[1]).toBe(String(7 * 24 * 60 * 60));
  });
});

describe("testConnection", () => {
  test("small write + read + delete succeeds", async () => {
    const result = await testConnection(clientWith(), bucket.name);
    expect(result.ok).toBe(true);
  });

  test("failure returns a PlainError, never throws", async () => {
    const client = clientWith(
      faultyFetch(nativeFetch, [
        {
          urlContains: ".lopload-connection-test-",
          method: "PUT",
          action: { kind: "s3Error", status: 403, code: "AccessDenied", message: "Access Denied" },
        },
      ]),
    );

    const result = await testConnection(client, bucket.name);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorClass).toBe("credentials");
      expect(result.error.message).not.toContain("AccessDenied");
    }
  });
});
