import { describe, expect, test, beforeEach } from "bun:test";
import { mockClient } from "aws-sdk-client-mock";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  deleteTrashItem,
  emptyTrash,
  listTrash,
  moveFileToTrash,
  moveFolderToTrash,
  restoreFileFromTrash,
  restoreFolderFromTrash,
} from "../../src/lib/s3/client";
import { trashKey } from "../../src/lib/s3/trash";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "ak", secretAccessKey: "sk" },
});
const s3Mock = mockClient(client);

beforeEach(() => {
  s3Mock.reset();
});

describe("moveFileToTrash", () => {
  test("copies to the trash location, then deletes the original", async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1024 });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await moveFileToTrash(client, "my-bucket", "photos/sunset.jpg", 1000);

    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls[0].args[0].input.Key).toBe(trashKey(1000, "photos/sunset.jpg"));
    const deleteCalls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(deleteCalls[0].args[0].input.Key).toBe("photos/sunset.jpg");
  });
});

describe("moveFolderToTrash", () => {
  test("copies + deletes every key under the folder, sharing one deletedAtMs", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "Vacation/" }, { Key: "Vacation/a.jpg" }],
      IsTruncated: false,
    });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await moveFolderToTrash(client, "my-bucket", "Vacation/", 2000);

    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls.map((c) => c.args[0].input.Key).sort()).toEqual(
      [trashKey(2000, "Vacation/"), trashKey(2000, "Vacation/a.jpg")].sort(),
    );
    // The folder already had its own marker object, so no synthetic one is needed.
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls[0].args[0].input.Delete?.Objects?.map((o) => o.Key).sort()).toEqual(
      ["Vacation/", "Vacation/a.jpg"].sort(),
    );
  });

  test("synthesizes a folder marker at the trash location when the source folder never had one", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: "Vacation/a.jpg" }],
      IsTruncated: false,
    });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await moveFolderToTrash(client, "my-bucket", "Vacation/", 3000);

    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Key).toBe(trashKey(3000, "Vacation/"));
    expect(putCalls[0].args[0].input.Body).toEqual(new Uint8Array(0));
  });

  test("an empty folder with no marker still leaves a trash record and deletes nothing", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    s3Mock.on(PutObjectCommand).resolves({});

    await moveFolderToTrash(client, "my-bucket", "Empty/", 4000);

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });
});

describe("restoreFileFromTrash", () => {
  test("throws and leaves the trashed copy untouched if something already exists at the original path", async () => {
    s3Mock.on(HeadObjectCommand).resolves({});

    await expect(restoreFileFromTrash(client, "my-bucket", 1000, "notes.txt")).rejects.toThrow();
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  test("copies back to the original path and deletes the trashed copy when nothing's in the way", async () => {
    // Nothing at the destination (so the restore proceeds), but the trashed
    // source is there — the copy heads it to size the transfer.
    s3Mock.on(HeadObjectCommand, { Key: "notes.txt" }).rejects({ name: "NotFound" });
    s3Mock
      .on(HeadObjectCommand, { Key: trashKey(1000, "notes.txt") })
      .resolves({ ContentLength: 1024 });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});

    await restoreFileFromTrash(client, "my-bucket", 1000, "notes.txt");

    expect(s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input.Key).toBe("notes.txt");
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
      trashKey(1000, "notes.txt"),
    );
  });
});

describe("restoreFolderFromTrash", () => {
  test("throws and leaves the trashed copies untouched if the original path is occupied", async () => {
    s3Mock.on(ListObjectsV2Command).resolvesOnce({ Contents: [{ Key: "Vacation/x.jpg" }] });

    await expect(
      restoreFolderFromTrash(client, "my-bucket", 2000, "Vacation/"),
    ).rejects.toThrow();
    expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(0);
  });

  test("restores every object back under the original path when it's free", async () => {
    s3Mock
      .on(ListObjectsV2Command)
      .resolvesOnce({ Contents: [], IsTruncated: false }) // conflict check
      .resolvesOnce({
        Contents: [
          { Key: trashKey(2000, "Vacation/") },
          { Key: trashKey(2000, "Vacation/a.jpg") },
        ],
        IsTruncated: false,
      });
    s3Mock.on(CopyObjectCommand).resolves({});
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await restoreFolderFromTrash(client, "my-bucket", 2000, "Vacation/");

    const copyCalls = s3Mock.commandCalls(CopyObjectCommand);
    expect(copyCalls.map((c) => c.args[0].input.Key).sort()).toEqual(
      ["Vacation/", "Vacation/a.jpg"].sort(),
    );
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls[0].args[0].input.Delete?.Objects?.map((o) => o.Key).sort()).toEqual(
      [trashKey(2000, "Vacation/"), trashKey(2000, "Vacation/a.jpg")].sort(),
    );
  });
});

describe("deleteTrashItem", () => {
  test("deletes a single trashed file", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});
    await deleteTrashItem(client, "my-bucket", 1000, "notes.txt", "file");
    expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(
      trashKey(1000, "notes.txt"),
    );
  });

  test("deletes every object under a trashed folder", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: trashKey(2000, "Vacation/") }, { Key: trashKey(2000, "Vacation/a.jpg") }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await deleteTrashItem(client, "my-bucket", 2000, "Vacation/", "folder");

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(2);
  });
});

describe("listTrash / emptyTrash", () => {
  test("listTrash groups raw trash objects into rows", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: trashKey(1000, "notes.txt"), Size: 10 },
        { Key: trashKey(2000, "Vacation/"), Size: 0 },
        { Key: trashKey(2000, "Vacation/a.jpg"), Size: 100 },
      ],
      IsTruncated: false,
    });

    const groups = await listTrash(client, "my-bucket");
    expect(groups).toHaveLength(2);
    const byKey = new Map(groups.map((g) => [g.originalKey, g]));
    expect(byKey.get("notes.txt")).toMatchObject({ kind: "file", totalSize: 10 });
    expect(byKey.get("Vacation/")).toMatchObject({ kind: "folder", totalSize: 100 });
  });

  test("emptyTrash deletes everything under the trash location", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: trashKey(1000, "a.txt") }, { Key: trashKey(2000, "b.txt") }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await emptyTrash(client, "my-bucket");

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(2);
  });
});
