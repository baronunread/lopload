import { describe, expect, test } from "bun:test";

import {
  basenameOf,
  expandDroppedPaths,
  type DropDirEntry,
  type DropFsOps,
} from "../../src/services/dragDropExpand";

/** In-memory fake filesystem tree for testing the pure expansion logic. */
function makeFakeFs(tree: Record<string, DropDirEntry[]>, sizes: Record<string, number>): DropFsOps {
  return {
    async readDir(path: string): Promise<DropDirEntry[]> {
      const entries = tree[path];
      if (!entries) throw new Error(`no such directory: ${path}`);
      return entries;
    },
    async size(path: string): Promise<number> {
      const s = sizes[path];
      if (s === undefined) throw new Error(`no size recorded for: ${path}`);
      return s;
    },
    joinPath(dirPath: string, childName: string): string {
      return `${dirPath}/${childName}`;
    },
  };
}

describe("basenameOf", () => {
  test("returns the last segment of a unix path", () => {
    expect(basenameOf("/Users/me/Photos/vacation.jpg")).toBe("vacation.jpg");
  });

  test("tolerates a trailing slash", () => {
    expect(basenameOf("/Users/me/Photos/")).toBe("Photos");
  });

  test("tolerates windows-style backslashes", () => {
    expect(basenameOf("C:\\Users\\me\\Photos\\vacation.jpg")).toBe("vacation.jpg");
  });
});

describe("expandDroppedPaths", () => {
  test("a plain file passes through unchanged, keyed by its own basename", async () => {
    const ops = makeFakeFs({}, { "/drop/photo.png": 1234 });
    const isDirectory = async () => false;

    const result = await expandDroppedPaths(["/drop/photo.png"], isDirectory, ops);

    expect(result).toEqual([{ path: "/drop/photo.png", name: "photo.png", size: 1234 }]);
  });

  test("a dropped folder expands to its files, prefixed by the folder name", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Vacation": [
        { name: "beach.jpg", isDirectory: false },
        { name: "clips", isDirectory: true },
      ],
      "/drop/Vacation/clips": [{ name: "sunset.mp4", isDirectory: false }],
    };
    const sizes = {
      "/drop/Vacation/beach.jpg": 100,
      "/drop/Vacation/clips/sunset.mp4": 200,
    };
    const ops = makeFakeFs(tree, sizes);
    const isDirectory = async (p: string) => p === "/drop/Vacation";

    const result = await expandDroppedPaths(["/drop/Vacation"], isDirectory, ops);

    expect(result).toEqual(
      expect.arrayContaining([
        { path: "/drop/Vacation/beach.jpg", name: "Vacation/beach.jpg", size: 100 },
        {
          path: "/drop/Vacation/clips/sunset.mp4",
          name: "Vacation/clips/sunset.mp4",
          size: 200,
        },
      ]),
    );
    expect(result).toHaveLength(2);
  });

  test("mixes loose files and folders dropped together", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Docs": [{ name: "readme.txt", isDirectory: false }],
    };
    const sizes = {
      "/drop/loose.txt": 5,
      "/drop/Docs/readme.txt": 6,
    };
    const ops = makeFakeFs(tree, sizes);
    const isDirectory = async (p: string) => p === "/drop/Docs";

    const result = await expandDroppedPaths(["/drop/loose.txt", "/drop/Docs"], isDirectory, ops);

    expect(result).toEqual(
      expect.arrayContaining([
        { path: "/drop/loose.txt", name: "loose.txt", size: 5 },
        { path: "/drop/Docs/readme.txt", name: "Docs/readme.txt", size: 6 },
      ]),
    );
    expect(result).toHaveLength(2);
  });

  test("recurses through nested empty subdirectories without producing entries for them", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Empty": [{ name: "sub", isDirectory: true }],
      "/drop/Empty/sub": [],
    };
    const ops = makeFakeFs(tree, {});
    const isDirectory = async (p: string) => p === "/drop/Empty";

    const result = await expandDroppedPaths(["/drop/Empty"], isDirectory, ops);

    expect(result).toEqual([]);
  });
});
