import { describe, expect, test } from "bun:test";

import { deriveTrayUploadTargets } from "../../src/services/trayState";
import type { Connection } from "../../src/lib/types";

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
