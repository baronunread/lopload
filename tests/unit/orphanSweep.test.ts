import { describe, expect, test, beforeAll } from "bun:test";
import { CreateMultipartUploadCommand, ListPartsCommand } from "@aws-sdk/client-s3";

import { abortStaleUploads } from "../../src/lib/s3/orphanSweep";
import { MemoryTransferStore } from "../../src/lib/stores/memory";
import type { Transfer } from "../../src/lib/types";
import { createS3Client } from "../../src/lib/s3/client";
import type { FetchFn } from "../../src/lib/s3/http-handler";
import { freshBucket, type Bucket } from "../support/minio";
import { faultyFetch } from "../support/faultyFetch";
import { nativeFetch } from "../setup";

let bucket: Bucket;

beforeAll(async () => {
  bucket = await freshBucket();
});

function clientWith(fetchFn: FetchFn = nativeFetch) {
  return createS3Client(bucket.connection, bucket.credentials, fetchFn);
}

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  const now = Date.now();
  return {
    id: "transfer-1",
    connectionId: "conn-1",
    key: "path/to/file.bin",
    localPath: "/local/file.bin",
    size: 100,
    partSize: 8 * 1024 * 1024,
    direction: "upload",
    state: { kind: "failed", errorClass: "unknown" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("abortStaleUploads", () => {
  test("aborts and clears the uploadId of a failed upload", async () => {
    const key = "orphan1/path/to/file.bin";
    const created = await bucket.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket.name, Key: key }),
    );
    const uploadId = created.UploadId!;
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1", key, uploadId }));

    const stats = await abortStaleUploads(clientWith(), bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 1, errors: 0 });
    expect((await store.get("t1"))?.uploadId).toBeUndefined();

    // Genuinely gone server-side: MinIO's AbortMultipartUpload is idempotent
    // (a second abort of the same id quietly resolves), but ListParts on an
    // aborted upload genuinely 404s with NoSuchUpload — proof the abort
    // really landed rather than being a no-op.
    await expect(
      bucket.client.send(
        new ListPartsCommand({ Bucket: bucket.name, Key: key, UploadId: uploadId }),
      ),
    ).rejects.toThrow();
  });

  test("ignores transfers without a persisted uploadId", async () => {
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1" }));

    const stats = await abortStaleUploads(clientWith(), bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 0 });
  });

  test("ignores non-failed transfers, even with a persisted uploadId (still in progress)", async () => {
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", uploadId: "upload-1", state: { kind: "queued" } }),
    );

    const stats = await abortStaleUploads(clientWith(), bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 0 });
    expect((await store.get("t1"))?.uploadId).toBe("upload-1");
  });

  test("ignores downloads", async () => {
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", uploadId: "upload-1", direction: "download" }),
    );

    const stats = await abortStaleUploads(clientWith(), bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 0 });
  });

  test("treats NoSuchUpload as already-clean, clearing the uploadId without counting an error", async () => {
    // A bogus uploadId that was never created — real MinIO genuinely rejects
    // this with NoSuchUpload, which is more faithful than faking the error.
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", key: "orphan5/file.bin", uploadId: "bogus-upload-id-12345" }),
    );

    const stats = await abortStaleUploads(clientWith(), bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 1, errors: 0 });
    expect((await store.get("t1"))?.uploadId).toBeUndefined();
  });

  test("counts an error and leaves the uploadId in place when abort fails for another reason", async () => {
    const key = "orphan6/file.bin";
    const client = clientWith(
      faultyFetch(nativeFetch, [
        {
          urlContains: key,
          method: "DELETE",
          action: { kind: "s3Error", status: 500, code: "InternalError", message: "network blip" },
        },
      ]),
    );
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1", key, uploadId: "some-upload-id" }));

    const stats = await abortStaleUploads(client, bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 1 });
    expect((await store.get("t1"))?.uploadId).toBe("some-upload-id");
  });

  test("only touches transfers for the given connection", async () => {
    const key1 = "orphan7/t1.bin";
    const created = await bucket.client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket.name, Key: key1 }),
    );
    const uploadId1 = created.UploadId!;
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", connectionId: "conn-1", key: key1, uploadId: uploadId1 }),
    );
    await store.save(
      makeTransfer({ id: "t2", connectionId: "conn-2", key: "orphan7/t2.bin", uploadId: "upload-2" }),
    );

    const stats = await abortStaleUploads(clientWith(), bucket.name, store, "conn-1");

    expect(stats).toEqual({ aborted: 1, errors: 0 });
    expect((await store.get("t2"))?.uploadId).toBe("upload-2");
  });
});
