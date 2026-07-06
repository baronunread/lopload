import { describe, expect, test } from "bun:test";
import { filterEntries } from "../../../../src/ui/browser/filter";
import type { RemoteEntry } from "../../../../src/lib/types";

const ENTRIES: RemoteEntry[] = [
  { kind: "folder", name: "Photos", key: "Photos/" },
  { kind: "file", name: "readme.txt", key: "readme.txt", size: 1, lastModified: 0 },
  { kind: "file", name: "PHOTO-2024.png", key: "PHOTO-2024.png", size: 1, lastModified: 0 },
];

describe("filterEntries", () => {
  test("empty query returns all entries unchanged", () => {
    expect(filterEntries(ENTRIES, "")).toBe(ENTRIES);
    expect(filterEntries(ENTRIES, "   ")).toBe(ENTRIES);
  });

  test("matches by case-insensitive substring", () => {
    const result = filterEntries(ENTRIES, "photo");
    expect(result.map((e) => e.name).sort()).toEqual(["PHOTO-2024.png", "Photos"]);
  });

  test("matches only exact substrings, not fuzzy", () => {
    expect(filterEntries(ENTRIES, "readme")).toEqual([ENTRIES[1]]);
    expect(filterEntries(ENTRIES, "zzz")).toEqual([]);
  });

  test("trims surrounding whitespace from the query", () => {
    expect(filterEntries(ENTRIES, "  readme  ")).toEqual([ENTRIES[1]]);
  });
});
