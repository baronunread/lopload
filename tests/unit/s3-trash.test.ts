import { describe, expect, test, beforeAll } from "bun:test";

import {
  createS3Client,
  deleteTrashItem,
  emptyTrash,
  listTrash,
  moveFileToTrash,
  moveFolderToTrash,
  restoreFileFromTrash,
  restoreFolderFromTrash,
} from "../../src/lib/s3/client";
import { TRASH_PREFIX, trashKey } from "../../src/lib/s3/trash";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/minio";
import { bucketProbe } from "../support/bucketProbe";
import { nativeFetch } from "../setup";

let bucket: Bucket;

beforeAll(async () => {
  bucket = await freshBucket();
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

describe("moveFileToTrash", () => {
  test("copies to the trash location, then deletes the original", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const key = "trash1/photos/sunset.jpg";
    await probe.put(key, new Uint8Array(1024));
    const deletedAt = Date.now();

    await moveFileToTrash(clientWith(), bucket.name, key, deletedAt);

    expect(await probe.has(trashKey(deletedAt, key))).toBe(true);
    expect(await probe.has(key)).toBe(false);
  });
});

describe("moveFolderToTrash", () => {
  test("copies + deletes every key under the folder, sharing one deletedAtMs", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const prefix = "trash2/Vacation/";
    await probe.put(prefix, new Uint8Array(0)); // the folder's own marker
    await probe.put(`${prefix}a.jpg`, new Uint8Array([1, 2, 3]));
    const deletedAt = Date.now();

    await moveFolderToTrash(clientWith(), bucket.name, prefix, deletedAt);

    expect(await probe.has(prefix)).toBe(false);
    expect(await probe.has(`${prefix}a.jpg`)).toBe(false);

    // The folder already had its own marker object, so restoring it must be
    // the original (copied) bytes, not a freshly-synthesized one — and no
    // extra trash object should exist beyond the two originals.
    const trashed = await probe.keys(trashKey(deletedAt, ""));
    expect(trashed.sort()).toEqual(
      [trashKey(deletedAt, prefix), trashKey(deletedAt, `${prefix}a.jpg`)].sort(),
    );
    expect(await probe.get(trashKey(deletedAt, prefix))).toEqual(new Uint8Array(0));
  });

  test("synthesizes a folder marker at the trash location when the source folder never had one", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const prefix = "trash3/Vacation/";
    await probe.put(`${prefix}a.jpg`, new Uint8Array([1])); // no marker for the folder itself
    const deletedAt = Date.now();

    await moveFolderToTrash(clientWith(), bucket.name, prefix, deletedAt);

    expect(await probe.get(trashKey(deletedAt, prefix))).toEqual(new Uint8Array(0));
    expect(await probe.has(trashKey(deletedAt, `${prefix}a.jpg`))).toBe(true);
  });

  test("an empty folder with no marker still leaves a trash record and deletes nothing", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const prefix = "trash4/Empty/";
    const deletedAt = Date.now();

    await moveFolderToTrash(clientWith(), bucket.name, prefix, deletedAt);

    expect(await probe.get(trashKey(deletedAt, prefix))).toEqual(new Uint8Array(0));
    expect(await probe.keys(trashKey(deletedAt, prefix))).toEqual([trashKey(deletedAt, prefix)]);
  });
});

describe("restoreFileFromTrash", () => {
  test("throws and leaves the trashed copy untouched if something already exists at the original path", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const originalKey = "trash5/notes.txt";
    await probe.put(originalKey, new Uint8Array([9])); // occupies the destination
    const deletedAt = Date.now();
    await probe.put(trashKey(deletedAt, originalKey), new Uint8Array([1, 2, 3]));

    await expect(
      restoreFileFromTrash(clientWith(), bucket.name, deletedAt, originalKey),
    ).rejects.toThrow();

    expect(await probe.get(trashKey(deletedAt, originalKey))).toEqual(new Uint8Array([1, 2, 3]));
    expect(await probe.get(originalKey)).toEqual(new Uint8Array([9]));
  });

  test("copies back to the original path and deletes the trashed copy when nothing's in the way", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const originalKey = "trash6/notes.txt";
    const deletedAt = Date.now();
    await probe.put(trashKey(deletedAt, originalKey), "restored content");

    await restoreFileFromTrash(clientWith(), bucket.name, deletedAt, originalKey);

    expect(await probe.getText(originalKey)).toBe("restored content");
    expect(await probe.has(trashKey(deletedAt, originalKey))).toBe(false);
  });
});

describe("restoreFolderFromTrash", () => {
  test("throws and leaves the trashed copies untouched if the original path is occupied", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const prefix = "trash7/Vacation/";
    const deletedAt = Date.now();
    await probe.put(`${prefix}x.jpg`, new Uint8Array([1])); // occupies the original path
    await probe.put(trashKey(deletedAt, prefix), new Uint8Array(0));
    await probe.put(trashKey(deletedAt, `${prefix}a.jpg`), new Uint8Array([2]));

    await expect(
      restoreFolderFromTrash(clientWith(), bucket.name, deletedAt, prefix),
    ).rejects.toThrow();

    expect(await probe.has(trashKey(deletedAt, prefix))).toBe(true);
    expect(await probe.has(trashKey(deletedAt, `${prefix}a.jpg`))).toBe(true);
  });

  test("restores every object back under the original path when it's free", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const prefix = "trash8/Vacation/";
    const deletedAt = Date.now();
    await probe.put(trashKey(deletedAt, prefix), new Uint8Array(0));
    await probe.put(trashKey(deletedAt, `${prefix}a.jpg`), new Uint8Array([3]));

    await restoreFolderFromTrash(clientWith(), bucket.name, deletedAt, prefix);

    expect(await probe.has(prefix)).toBe(true);
    expect(await probe.has(`${prefix}a.jpg`)).toBe(true);
    expect(await probe.has(trashKey(deletedAt, prefix))).toBe(false);
    expect(await probe.has(trashKey(deletedAt, `${prefix}a.jpg`))).toBe(false);
  });
});

describe("deleteTrashItem", () => {
  test("deletes a single trashed file", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const deletedAt = Date.now();
    const originalKey = "trash9/notes.txt";
    await probe.put(trashKey(deletedAt, originalKey), new Uint8Array([1]));

    await deleteTrashItem(clientWith(), bucket.name, deletedAt, originalKey, "file");

    expect(await probe.has(trashKey(deletedAt, originalKey))).toBe(false);
  });

  test("deletes every object under a trashed folder", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const deletedAt = Date.now();
    const prefix = "trash10/Vacation/";
    await probe.put(trashKey(deletedAt, prefix), new Uint8Array(0));
    await probe.put(trashKey(deletedAt, `${prefix}a.jpg`), new Uint8Array([1]));

    await deleteTrashItem(clientWith(), bucket.name, deletedAt, prefix, "folder");

    expect(await probe.keys(trashKey(deletedAt, prefix))).toEqual([]);
  });
});

describe("listTrash / emptyTrash", () => {
  test("listTrash groups raw trash objects into rows", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const deletedAt1 = Date.now();
    const deletedAt2 = deletedAt1 + 1;
    await probe.put(trashKey(deletedAt1, "trash11/notes.txt"), new Uint8Array(10));
    await probe.put(trashKey(deletedAt2, "trash11/Vacation/"), new Uint8Array(0));
    await probe.put(trashKey(deletedAt2, "trash11/Vacation/a.jpg"), new Uint8Array(100));

    // The bucket is shared across this whole file, so other tests' trash
    // entries are present too — assert on the rows we planted, not the total
    // count, the way the old isolated-mock test could.
    const groups = await listTrash(clientWith(), bucket.name);
    const byKey = new Map(groups.map((g) => [g.originalKey, g]));
    expect(byKey.get("trash11/notes.txt")).toMatchObject({ kind: "file", totalSize: 10 });
    expect(byKey.get("trash11/Vacation/")).toMatchObject({ kind: "folder", totalSize: 100 });
  });

  test("emptyTrash deletes everything under the trash location", async () => {
    const probe = bucketProbe(bucket.client, bucket.name);
    const deletedAt = Date.now();
    await probe.put(trashKey(deletedAt, "trash12/a.txt"), new Uint8Array([1]));
    await probe.put(trashKey(deletedAt + 1, "trash12/b.txt"), new Uint8Array([2]));

    await emptyTrash(clientWith(), bucket.name);

    // Genuinely everything — including leftovers from earlier tests in this
    // file, which is a stronger proof of "empties the trash" than checking
    // just the two keys we added here.
    expect(await probe.keys(TRASH_PREFIX)).toEqual([]);
  });
});
