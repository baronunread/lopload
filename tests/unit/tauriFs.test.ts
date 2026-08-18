import { describe, expect, mock, test } from "bun:test";

// plugin-fs and the IPC are mocked module-wide (as tauriUpdater.test.ts does)
// because what's under test is which calls cross the boundary and in what
// order — a write to a folder Tauri's fs scope doesn't cover has to be preceded
// by the grant, or the write comes back "forbidden path".

const order: string[] = [];

const invoke = mock(async (cmd: string, payload?: unknown): Promise<unknown> => {
  order.push(`invoke:${cmd}:${JSON.stringify(payload)}`);
  return undefined;
});
const writeFile = mock(async (path: string) => {
  order.push(`writeFile:${path}`);
});
const mkdir = mock(async (path: string) => {
  order.push(`mkdir:${path}`);
});
const size = mock(async (path: string) => {
  order.push(`size:${path}`);
  return 7;
});
const remove = mock(async () => {});
const rename = mock(async () => {});
const open = mock(async () => ({
  truncate: async () => {},
  close: async () => {},
}));

mock.module("@tauri-apps/api/core", () => ({ invoke }));
mock.module("@tauri-apps/plugin-fs", () => ({
  mkdir,
  open,
  remove,
  rename,
  size,
  writeFile,
  readDir: mock(async () => []),
  stat: mock(async () => ({ isDirectory: false })),
  exists: mock(async () => true),
  // Not used by anything under test here, but this mock.module call replaces
  // the module for the whole test process — src/tauri/logSink.ts imports
  // writeTextFile from the real module, and without a stub here its import
  // breaks for every test file that runs after this one.
  writeTextFile: mock(async () => {}),
  SeekMode: { Start: 0, Current: 1, End: 2 },
}));

const { dirnameOf, tauriFileWriter } = await import("../../src/tauri/fs");

function grantsFor(path: string): number {
  return order.filter((entry) => entry === `invoke:allow_fs_dir:${JSON.stringify({ path })}`)
    .length;
}

describe("tauri/fs dirnameOf", () => {
  test("takes the parent across either separator", () => {
    expect(dirnameOf("D:\\Documents\\Downloads\\backup.tar")).toBe("D:\\Documents\\Downloads");
    expect(dirnameOf("/home/u/backup.tar")).toBe("/home/u");
    // A path built by joining a Tauri tempDir() (which keeps its trailing
    // separator) with "/name" mixes both.
    expect(dirnameOf("C:\\Users\\u\\AppData\\Local\\Temp\\/lopload-open-x")).toBe(
      "C:\\Users\\u\\AppData\\Local\\Temp\\",
    );
  });

  test("keeps the separator when the parent is a root", () => {
    expect(dirnameOf("D:\\backup.tar")).toBe("D:\\");
    expect(dirnameOf("/backup.tar")).toBe("/");
  });
});

describe("tauri/fs writer scope grants", () => {
  test("the destination folder is granted before the first chunk is written", async () => {
    const temp = "D:\\Documents\\Downloads\\backup.tar.lopload-download";
    await tauriFileWriter.writeChunk(temp, new Uint8Array([1, 2, 3]), true);

    expect(grantsFor("D:\\Documents\\Downloads")).toBe(1);
    expect(order.indexOf("invoke:allow_fs_dir:{\"path\":\"D:\\\\Documents\\\\Downloads\"}")).
      toBeLessThan(order.indexOf(`writeFile:${temp}`));
    expect(mkdir).toHaveBeenCalledWith("D:\\Documents\\Downloads", { recursive: true });
  });

  test("later chunks reuse the grant instead of paying for the IPC again", async () => {
    const temp = "D:\\Documents\\Downloads\\backup.tar.lopload-download";
    await tauriFileWriter.writeChunk(temp, new Uint8Array([4]), false);
    await tauriFileWriter.writeChunk(temp, new Uint8Array([5]), false);

    expect(grantsFor("D:\\Documents\\Downloads")).toBe(1);
  });

  test("a resume check grants first, so a half-downloaded file isn't reported missing", async () => {
    const temp = "E:\\media\\movie.mkv.lopload-download";
    expect(await tauriFileWriter.sizeOf(temp)).toBe(7);

    expect(grantsFor("E:\\media")).toBe(1);
    expect(order.indexOf("invoke:allow_fs_dir:{\"path\":\"E:\\\\media\"}")).toBeLessThan(
      order.indexOf(`size:${temp}`),
    );
  });

  test("each destination folder is granted on its own", async () => {
    await tauriFileWriter.allocate("E:\\other\\big.iso.lopload-download", 1024);

    expect(grantsFor("E:\\other")).toBe(1);
  });
});
