import { describe, expect, test } from "bun:test";
import { DEFAULT_SORT, nextSortState, sortEntries, type SortState } from "../../../../src/ui/browser/sort";
import type { RemoteEntry } from "../../../../src/lib/types";

const ENTRIES: RemoteEntry[] = [
  { kind: "file", name: "banana.txt", key: "banana.txt", size: 300, lastModified: 200 },
  { kind: "folder", name: "Zebra", key: "Zebra/" },
  { kind: "file", name: "Apple.txt", key: "Apple.txt", size: 100, lastModified: 300 },
  { kind: "folder", name: "apps", key: "apps/" },
  { kind: "file", name: "cherry.txt", key: "cherry.txt", size: 200, lastModified: 100 },
];

describe("sortEntries", () => {
  test("defaults to name ascending, folders before files", () => {
    const sorted = sortEntries(ENTRIES, DEFAULT_SORT);
    expect(sorted.map((e) => e.name)).toEqual(["apps", "Zebra", "Apple.txt", "banana.txt", "cherry.txt"]);
  });

  test("name sort is case-insensitive", () => {
    const sorted = sortEntries(ENTRIES, { key: "name", direction: "asc" });
    const files = sorted.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(["Apple.txt", "banana.txt", "cherry.txt"]);
  });

  test("name descending reverses within each group, folders still first", () => {
    const sorted = sortEntries(ENTRIES, { key: "name", direction: "desc" });
    expect(sorted.map((e) => e.name)).toEqual(["Zebra", "apps", "cherry.txt", "banana.txt", "Apple.txt"]);
  });

  test("sorts by size, folders still grouped first", () => {
    const sorted = sortEntries(ENTRIES, { key: "size", direction: "asc" });
    expect(sorted.map((e) => e.kind)).toEqual(["folder", "folder", "file", "file", "file"]);
    const files = sorted.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(["Apple.txt", "cherry.txt", "banana.txt"]);
  });

  test("sorts by size descending", () => {
    const sorted = sortEntries(ENTRIES, { key: "size", direction: "desc" });
    const files = sorted.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(["banana.txt", "cherry.txt", "Apple.txt"]);
  });

  test("sorts by modified date", () => {
    const sorted = sortEntries(ENTRIES, { key: "modified", direction: "asc" });
    const files = sorted.filter((e) => e.kind === "file").map((e) => e.name);
    expect(files).toEqual(["cherry.txt", "banana.txt", "Apple.txt"]);
  });

  test("folders with no size/modified are stable and tie-break by name", () => {
    const sorted = sortEntries(ENTRIES, { key: "size", direction: "asc" });
    const folders = sorted.filter((e) => e.kind === "folder").map((e) => e.name);
    expect(folders).toEqual(["apps", "Zebra"]);
  });
});

describe("nextSortState", () => {
  test("clicking a new column starts ascending", () => {
    const current: SortState = { key: "name", direction: "desc" };
    expect(nextSortState(current, "size")).toEqual({ key: "size", direction: "asc" });
  });

  test("clicking the active column flips direction", () => {
    const current: SortState = { key: "name", direction: "asc" };
    expect(nextSortState(current, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextSortState({ key: "name", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });
});
