import { describe, expect, test } from "bun:test";

import {
  groupTrashObjects,
  isExpired,
  isTrashKey,
  parseTrashKey,
  purgeAt,
  trashKey,
  TRASH_PREFIX,
  TRASH_RETENTION_MS,
} from "../../src/lib/s3/trash";

describe("trashKey / parseTrashKey", () => {
  test("round-trips a plain key", () => {
    const key = trashKey(1_700_000_000_000, "photos/sunset.jpg");
    expect(key).toBe(".lopload-trash/1700000000000/photos/sunset.jpg");
    expect(parseTrashKey(key)).toEqual({
      deletedAtMs: 1_700_000_000_000,
      originalKey: "photos/sunset.jpg",
    });
  });

  test("round-trips an original key containing many slashes", () => {
    const original = "a/b/c/d/e/file.txt";
    const key = trashKey(42, original);
    expect(parseTrashKey(key)).toEqual({ deletedAtMs: 42, originalKey: original });
  });

  test("round-trips an original key with unicode characters", () => {
    const original = "документы/résumé 📄/café.pdf";
    const key = trashKey(1234, original);
    expect(parseTrashKey(key)).toEqual({ deletedAtMs: 1234, originalKey: original });
  });

  test("round-trips a folder key (trailing slash)", () => {
    const original = "Vacation/2024/";
    const key = trashKey(99, original);
    expect(parseTrashKey(key)).toEqual({ deletedAtMs: 99, originalKey: original });
  });

  test("parseTrashKey returns null for keys outside the trash location", () => {
    expect(parseTrashKey("photos/sunset.jpg")).toBeNull();
  });

  test("parseTrashKey returns null for a malformed trash key (no timestamp segment)", () => {
    expect(parseTrashKey(TRASH_PREFIX)).toBeNull();
    expect(parseTrashKey(`${TRASH_PREFIX}not-a-number/foo.txt`)).toBeNull();
  });

  test("parseTrashKey returns null when there's a timestamp but no original key", () => {
    expect(parseTrashKey(`${TRASH_PREFIX}123/`)).toBeNull();
    expect(parseTrashKey(`${TRASH_PREFIX}123`)).toBeNull();
  });

  test("isTrashKey", () => {
    expect(isTrashKey(TRASH_PREFIX)).toBe(true);
    expect(isTrashKey(trashKey(1, "a.txt"))).toBe(true);
    expect(isTrashKey("photos/a.txt")).toBe(false);
  });
});

describe("expiry math", () => {
  test("purgeAt is deletedAt plus the retention window", () => {
    expect(purgeAt(1000)).toBe(1000 + TRASH_RETENTION_MS);
    expect(purgeAt(1000, 5000)).toBe(6000);
  });

  test("isExpired is false right up to the retention boundary, true at and after it", () => {
    const deletedAtMs = 1_000_000;
    expect(isExpired(deletedAtMs, deletedAtMs + TRASH_RETENTION_MS - 1)).toBe(false);
    expect(isExpired(deletedAtMs, deletedAtMs + TRASH_RETENTION_MS)).toBe(true);
    expect(isExpired(deletedAtMs, deletedAtMs + TRASH_RETENTION_MS + 1)).toBe(true);
  });

  test("isExpired honors a custom retention window", () => {
    expect(isExpired(0, 500, 1000)).toBe(false);
    expect(isExpired(0, 1000, 1000)).toBe(true);
  });
});

describe("groupTrashObjects", () => {
  test("a lone trashed file is its own file-kind group", () => {
    const groups = groupTrashObjects([
      { trashKey: trashKey(10, "notes.txt"), originalKey: "notes.txt", deletedAtMs: 10, size: 42 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      originalKey: "notes.txt",
      kind: "file",
      deletedAtMs: 10,
      totalSize: 42,
    });
    expect(groups[0].members).toEqual([trashKey(10, "notes.txt")]);
  });

  test("a folder delete (with its own marker) collapses into one folder-kind group", () => {
    const deletedAtMs = 20;
    const objects = [
      { trashKey: trashKey(deletedAtMs, "Vacation/"), originalKey: "Vacation/", deletedAtMs, size: 0 },
      {
        trashKey: trashKey(deletedAtMs, "Vacation/a.jpg"),
        originalKey: "Vacation/a.jpg",
        deletedAtMs,
        size: 100,
      },
      {
        trashKey: trashKey(deletedAtMs, "Vacation/2024/b.jpg"),
        originalKey: "Vacation/2024/b.jpg",
        deletedAtMs,
        size: 200,
      },
    ];
    const groups = groupTrashObjects(objects);
    expect(groups).toHaveLength(1);
    expect(groups[0].originalKey).toBe("Vacation/");
    expect(groups[0].kind).toBe("folder");
    expect(groups[0].totalSize).toBe(300);
    expect(new Set(groups[0].members)).toEqual(new Set(objects.map((o) => o.trashKey)));
  });

  test("two unrelated items trashed at the same instant stay separate groups", () => {
    const deletedAtMs = 30;
    const objects = [
      { trashKey: trashKey(deletedAtMs, "a.txt"), originalKey: "a.txt", deletedAtMs, size: 1 },
      { trashKey: trashKey(deletedAtMs, "b.txt"), originalKey: "b.txt", deletedAtMs, size: 2 },
    ];
    const groups = groupTrashObjects(objects);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.originalKey).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("items trashed at different instants never merge, even with the same original path", () => {
    const objects = [
      { trashKey: trashKey(1, "notes.txt"), originalKey: "notes.txt", deletedAtMs: 1, size: 1 },
      { trashKey: trashKey(2, "notes.txt"), originalKey: "notes.txt", deletedAtMs: 2, size: 2 },
    ];
    const groups = groupTrashObjects(objects);
    expect(groups).toHaveLength(2);
  });
});
