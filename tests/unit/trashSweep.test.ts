import { describe, expect, test, beforeEach } from "bun:test";

import { sweepTrash } from "../../src/lib/s3/trashSweep";
import { TRASH_PREFIX, trashKey } from "../../src/lib/s3/trash";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/storage";
import { bucketProbe } from "../support/bucketProbe";
import { faultyFetch } from "../support/faultyFetch";
import { nativeFetch } from "../setup";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 30 * DAY;

// sweepTrash scans the *entire* trash prefix with no way to scope it to one
// test's keys, so — unlike the other migrated files — this one needs a fresh
// bucket per test rather than one shared per file, to keep the exact
// scanned/purged/errors counts below meaningful. freshBucket() only creates a
// new (cheap) bucket, not a new container, so this stays fast.
let bucket: Bucket;

beforeEach(async () => {
  bucket = await freshBucket();
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

/** Runs `fn` over `items` with at most `limit` in flight — used to create
 * hundreds/thousands of real objects quickly without opening a socket per
 * item all at once against local MinIO. */
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

describe("sweepTrash", () => {
  test("purges only entries older than the retention window", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const now = Date.now();
    await probe.put(trashKey(now - 40 * DAY, "old-file.txt"), new Uint8Array([1]));
    await probe.put(trashKey(now - 1 * DAY, "recent-file.txt"), new Uint8Array([1]));

    const stats = await sweepTrash(clientWith(), bucket.name, now, RETENTION);

    expect(stats.scanned).toBe(2);
    expect(stats.purged).toBe(1);
    expect(stats.errors).toBe(0);
    expect(await probe.has(trashKey(now - 40 * DAY, "old-file.txt"))).toBe(false);
    expect(await probe.has(trashKey(now - 1 * DAY, "recent-file.txt"))).toBe(true);
  });

  test("ignores keys that aren't shaped like trash entries", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const now = Date.now();
    const strayKey = `${TRASH_PREFIX}not-a-timestamp/file.txt`;
    await probe.put(strayKey, new Uint8Array([1]));

    const stats = await sweepTrash(clientWith(), bucket.name, now, RETENTION);

    expect(stats.purged).toBe(0);
    expect(await probe.has(strayKey)).toBe(true);
  });

  test("paginates via ContinuationToken", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const now = Date.now();
    // Real ListObjectsV2 defaults to a 1000-key page — this forces a genuine
    // second page rather than a scripted resolvesOnce/resolvesOnce mock.
    const KEYS = 1200;
    await mapPool(
      Array.from({ length: KEYS }, (_, i) => i),
      100,
      (i) => probe.put(trashKey(now - 40 * DAY, `sweep-page/file-${i}.txt`), new Uint8Array(0)),
    );

    const stats = await sweepTrash(clientWith(), bucket.name, now, RETENTION);

    expect(stats.scanned).toBe(KEYS);
    expect(stats.purged).toBe(KEYS);
  }, 30_000);

  test("batches deletes in groups of 1000", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const now = Date.now();
    // A real DeleteObjects request rejects a batch bigger than 1000 keys, so
    // purging all 1500 for real is itself proof the sweep batches correctly.
    const KEYS = 1500;
    await mapPool(
      Array.from({ length: KEYS }, (_, i) => i),
      100,
      (i) => probe.put(trashKey(now - 40 * DAY, `sweep-batch/file-${i}.txt`), new Uint8Array(0)),
    );

    const stats = await sweepTrash(clientWith(), bucket.name, now, RETENTION);

    expect(stats.purged).toBe(KEYS);
    expect(stats.errors).toBe(0);
    expect(await probe.keys(TRASH_PREFIX)).toEqual([]);
  }, 30_000);

  test("swallows errors from ListObjectsV2 and never throws", async () => {
    const now = Date.now();
    const client = clientWith(
      faultyFetch(nativeFetch, [
        {
          urlContains: bucket.name,
          method: "GET",
          action: { kind: "networkError", message: "network down" },
        },
      ]),
    );

    const stats = await sweepTrash(client, bucket.name, now, RETENTION);

    expect(stats.errors).toBeGreaterThan(0);
    expect(stats.purged).toBe(0);
  });

  test("swallows errors from an individual DeleteObjects batch and continues", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const now = Date.now();
    const KEYS = 1500;
    await mapPool(
      Array.from({ length: KEYS }, (_, i) => i),
      100,
      (i) => probe.put(trashKey(now - 40 * DAY, `sweep-batch-fail/file-${i}.txt`), new Uint8Array(0)),
    );

    // DeleteObjects is a POST to `<bucket>?delete` — fault the first batch's
    // calls only. The SDK retries a 500 up to its default 3 attempts before
    // giving up, so `times: 3` has to cover every retry of that first
    // (1000-key) batch for the error to actually surface to the app; the
    // second (remaining 500-key) batch's calls land after that budget is
    // spent and go through to real MinIO untouched.
    const client = clientWith(
      faultyFetch(nativeFetch, [
        {
          urlContains: "?delete",
          method: "POST",
          times: 3,
          action: { kind: "s3Error", status: 500, code: "InternalError", message: "batch failed" },
        },
      ]),
    );

    const stats = await sweepTrash(client, bucket.name, now, RETENTION);

    expect(stats.errors).toBe(1);
    expect(stats.purged).toBe(500);
  }, 30_000);
});
