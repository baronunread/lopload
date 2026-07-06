import { describe, expect, mock, test } from "bun:test";

describe("tauri/updater", () => {
  test("checkForUpdate reports the version and remembers the handle for install; a later null check clears it", async () => {
    const downloadAndInstall = mock(async () => {});
    const check = mock(async (): Promise<{ version: string; downloadAndInstall: typeof downloadAndInstall } | null> => ({
      version: "1.2.3",
      downloadAndInstall,
    }));
    const relaunch = mock(async () => {});

    mock.module("@tauri-apps/plugin-updater", () => ({ check }));
    mock.module("@tauri-apps/plugin-process", () => ({ relaunch }));

    const { checkForUpdate, installAndRelaunch } = await import("../../src/tauri/updater");

    const version = await checkForUpdate();
    expect(version).toBe("1.2.3");
    expect(check).toHaveBeenCalledTimes(1);

    await installAndRelaunch();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);

    check.mockImplementationOnce(async () => null);
    const noVersion = await checkForUpdate();
    expect(noVersion).toBeNull();

    await installAndRelaunch();
    // No new update was found, so the stale handle from before must not be reused.
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
