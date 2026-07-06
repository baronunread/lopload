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

    expect(result.files).toEqual([{ path: "/drop/photo.png", name: "photo.png", size: 1234 }]);
    expect(result.skipped).toEqual([]);
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

    expect(result.files).toEqual(
      expect.arrayContaining([
        {
          path: "/drop/Vacation/beach.jpg",
          name: "Vacation/beach.jpg",
          size: 100,
          folderId: expect.any(String),
          folderName: "Vacation",
        },
        {
          path: "/drop/Vacation/clips/sunset.mp4",
          name: "Vacation/clips/sunset.mp4",
          size: 200,
          folderId: expect.any(String),
          folderName: "Vacation",
        },
      ]),
    );
    expect(result.files).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    // Every file under the same dropped folder shares one folderId, so the
    // UI can group them into a single aggregated row.
    expect(result.files[0].folderId).toBe(result.files[1].folderId);
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

    expect(result.files).toEqual(
      expect.arrayContaining([
        { path: "/drop/loose.txt", name: "loose.txt", size: 5 },
        {
          path: "/drop/Docs/readme.txt",
          name: "Docs/readme.txt",
          size: 6,
          folderId: expect.any(String),
          folderName: "Docs",
        },
      ]),
    );
    expect(result.files).toHaveLength(2);
  });

  test("recurses through nested empty subdirectories without producing entries for them", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Empty": [{ name: "sub", isDirectory: true }],
      "/drop/Empty/sub": [],
    };
    const ops = makeFakeFs(tree, {});
    const isDirectory = async (p: string) => p === "/drop/Empty";

    const result = await expandDroppedPaths(["/drop/Empty"], isDirectory, ops);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("filters out OS junk files like .DS_Store at any depth", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Photos": [
        { name: ".DS_Store", isDirectory: false },
        { name: "cat.jpg", isDirectory: false },
        { name: "sub", isDirectory: true },
      ],
      "/drop/Photos/sub": [
        { name: "Thumbs.db", isDirectory: false },
        { name: "dog.jpg", isDirectory: false },
      ],
    };
    const sizes = {
      "/drop/Photos/cat.jpg": 10,
      "/drop/Photos/sub/dog.jpg": 20,
    };
    const ops = makeFakeFs(tree, sizes);
    const isDirectory = async (p: string) => p === "/drop/Photos";

    const result = await expandDroppedPaths(["/drop/Photos"], isDirectory, ops);

    expect(result.files.map((f) => f.name).sort()).toEqual([
      "Photos/cat.jpg",
      "Photos/sub/dog.jpg",
    ]);
    // Junk is silently dropped, not reported as a failure.
    expect(result.skipped).toEqual([]);
  });

  test("ignores a junk file dropped directly", async () => {
    const ops = makeFakeFs({}, {});
    const isDirectory = async () => false;

    const result = await expandDroppedPaths(["/drop/.DS_Store"], isDirectory, ops);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("an unreadable file is skipped without failing the rest of the batch", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Mixed": [
        { name: "ok.txt", isDirectory: false },
        { name: "broken.txt", isDirectory: false },
      ],
    };
    // No size recorded for broken.txt → ops.size throws for it.
    const sizes = { "/drop/Mixed/ok.txt": 7 };
    const ops = makeFakeFs(tree, sizes);
    const isDirectory = async (p: string) => p === "/drop/Mixed";

    const result = await expandDroppedPaths(["/drop/Mixed"], isDirectory, ops);

    expect(result.files).toEqual([
      {
        path: "/drop/Mixed/ok.txt",
        name: "Mixed/ok.txt",
        size: 7,
        folderId: expect.any(String),
        folderName: "Mixed",
      },
    ]);
    expect(result.skipped).toEqual(["/drop/Mixed/broken.txt"]);
  });

  test("an unreadable subdirectory is skipped without failing sibling files", async () => {
    const tree: Record<string, DropDirEntry[]> = {
      "/drop/Root": [
        { name: "file.txt", isDirectory: false },
        { name: "locked", isDirectory: true },
      ],
      // "/drop/Root/locked" intentionally absent → readDir throws for it.
    };
    const sizes = { "/drop/Root/file.txt": 3 };
    const ops = makeFakeFs(tree, sizes);
    const isDirectory = async (p: string) => p === "/drop/Root";

    const result = await expandDroppedPaths(["/drop/Root"], isDirectory, ops);

    expect(result.files).toEqual([
      {
        path: "/drop/Root/file.txt",
        name: "Root/file.txt",
        size: 3,
        folderId: expect.any(String),
        folderName: "Root",
      },
    ]);
    expect(result.skipped).toEqual(["/drop/Root/locked"]);
  });

  test("a top-level path that can't even be stat'd is skipped, others proceed", async () => {
    const ops = makeFakeFs({}, { "/drop/good.txt": 1 });
    const isDirectory = async (p: string) => {
      if (p === "/drop/ghost") throw new Error("forbidden path");
      return false;
    };

    const result = await expandDroppedPaths(["/drop/ghost", "/drop/good.txt"], isDirectory, ops);

    expect(result.files).toEqual([{ path: "/drop/good.txt", name: "good.txt", size: 1 }]);
    expect(result.skipped).toEqual(["/drop/ghost"]);
  });
});
