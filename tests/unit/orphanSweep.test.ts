import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import { AbortMultipartUploadCommand, S3Client } from "@aws-sdk/client-s3";

import { abortStaleUploads } from "../../src/lib/s3/orphanSweep";
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
    s3Mock.on(AbortMultipartUploadCommand).resolves({});
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1", uploadId: "upload-1" }));

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 1, errors: 0 });
    const calls = s3Mock.commandCalls(AbortMultipartUploadCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: "b",
      Key: "path/to/file.bin",
      UploadId: "upload-1",
    });
    expect((await store.get("t1"))?.uploadId).toBeUndefined();
  });

  test("ignores transfers without a persisted uploadId", async () => {
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1" }));

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 0 });
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0);
  });

  test("ignores non-failed transfers, even with a persisted uploadId (still in progress)", async () => {
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", uploadId: "upload-1", state: { kind: "queued" } }),
    );

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 0 });
    expect((await store.get("t1"))?.uploadId).toBe("upload-1");
  });

  test("ignores downloads", async () => {
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", uploadId: "upload-1", direction: "download" }),
    );

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 0 });
    expect(s3Mock.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0);
  });

  test("treats NoSuchUpload as already-clean, clearing the uploadId without counting an error", async () => {
    const err = Object.assign(new Error("The specified upload does not exist."), {
      name: "NoSuchUpload",
    });
    s3Mock.on(AbortMultipartUploadCommand).rejects(err);
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1", uploadId: "upload-1" }));

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 1, errors: 0 });
    expect((await store.get("t1"))?.uploadId).toBeUndefined();
  });

  test("counts an error and leaves the uploadId in place when abort fails for another reason", async () => {
    s3Mock.on(AbortMultipartUploadCommand).rejects(new Error("network blip"));
    const store = new MemoryTransferStore();
    await store.save(makeTransfer({ id: "t1", uploadId: "upload-1" }));

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 0, errors: 1 });
    expect((await store.get("t1"))?.uploadId).toBe("upload-1");
  });

  test("only touches transfers for the given connection", async () => {
    const store = new MemoryTransferStore();
    await store.save(
      makeTransfer({ id: "t1", connectionId: "conn-1", uploadId: "upload-1" }),
    );
    await store.save(
      makeTransfer({ id: "t2", connectionId: "conn-2", uploadId: "upload-2" }),
    );
    s3Mock.on(AbortMultipartUploadCommand).resolves({});

    const stats = await abortStaleUploads(client, "b", store, "conn-1");

    expect(stats).toEqual({ aborted: 1, errors: 0 });
    expect((await store.get("t2"))?.uploadId).toBe("upload-2");
  });
});
