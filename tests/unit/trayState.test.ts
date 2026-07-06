import { describe, expect, test } from "bun:test";

import { deriveTrayUploadTargets, trackLastUploaded } from "../../src/services/trayState";
import type { Connection, EngineEvent, Transfer } from "../../src/lib/types";

function makeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "Videos",
    endpoint: "https://example.com",
    bucket: "bucket",
    lastPrefix: "",
    createdAt: 0,
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "t-1",
    connectionId: "conn-1",
    key: "folder/clip.mp4",
    localPath: "/local/clip.mp4",
    size: 100,
    partSize: 100,
    direction: "upload",
    state: { kind: "queued" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("deriveTrayUploadTargets", () => {
  test("maps each connection to a tray upload target", () => {
    const connections = [
      makeConnection({ id: "a", name: "Videos" }),
      makeConnection({ id: "b", name: "Photos" }),
    ];
    expect(deriveTrayUploadTargets(connections)).toEqual([
      { id: "a", name: "Videos" },
      { id: "b", name: "Photos" },
    ]);
  });

  test("returns an empty list when there are no connections", () => {
    expect(deriveTrayUploadTargets([])).toEqual([]);
  });
});

describe("trackLastUploaded", () => {
  test("ignores batch-finished and non-upload events", () => {
    const batchEvent: EngineEvent = { type: "batch-finished", uploaded: 1, downloaded: 0, failed: 0 };
    expect(trackLastUploaded(null, batchEvent)).toBeNull();

    const downloadEvent: EngineEvent = {
      type: "transfer-updated",
      transfer: makeTransfer({ direction: "download", state: { kind: "downloaded" } }),
    };
    expect(trackLastUploaded(null, downloadEvent)).toBeNull();
  });

  test("clears when a fresh upload batch starts", () => {
    const existing = { connectionId: "conn-1", key: "old.txt", name: "old.txt" };
    const freshlyQueued: EngineEvent = {
      type: "transfer-updated",
      transfer: makeTransfer({ state: { kind: "queued" }, createdAt: 5, updatedAt: 5 }),
    };
    expect(trackLastUploaded(existing, freshlyQueued)).toBeNull();
  });

  test("does not clear on a re-queue (retry) of an existing transfer", () => {
    const existing = { connectionId: "conn-1", key: "old.txt", name: "old.txt" };
    const requeued: EngineEvent = {
      type: "transfer-updated",
      transfer: makeTransfer({ state: { kind: "queued" }, createdAt: 1, updatedAt: 9 }),
    };
    expect(trackLastUploaded(existing, requeued)).toBe(existing);
  });

  test("sets the last uploaded file once verification finishes", () => {
    const uploaded: EngineEvent = {
      type: "transfer-updated",
      transfer: makeTransfer({ key: "folder/clip.mp4", state: { kind: "uploaded" } }),
    };
    expect(trackLastUploaded(null, uploaded)).toEqual({
      connectionId: "conn-1",
      key: "folder/clip.mp4",
      name: "clip.mp4",
    });
  });

  test("a newer finished upload replaces the previous one", () => {
    const first = { connectionId: "conn-1", key: "a.txt", name: "a.txt" };
    const second: EngineEvent = {
      type: "transfer-updated",
      transfer: makeTransfer({ id: "t-2", key: "b.txt", state: { kind: "uploaded" } }),
    };
    expect(trackLastUploaded(first, second)).toEqual({
      connectionId: "conn-1",
      key: "b.txt",
      name: "b.txt",
    });
  });

  test("leaves the current value untouched for in-flight progress updates", () => {
    const existing = { connectionId: "conn-1", key: "a.txt", name: "a.txt" };
    const sending: EngineEvent = {
      type: "transfer-updated",
      transfer: makeTransfer({ state: { kind: "sending", percent: 42 } }),
    };
    expect(trackLastUploaded(existing, sending)).toBe(existing);
  });
});
