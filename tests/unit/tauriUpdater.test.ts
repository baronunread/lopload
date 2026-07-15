import { describe, expect, mock, test } from "bun:test";

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

describe("tauri/updater", () => {
  test("checkForUpdate reports the version and remembers the handle; a later null check clears it", async () => {
    const downloadAndInstall = mock(async (_onEvent?: (e: DownloadEvent) => void) => {});
    const check = mock(async (): Promise<{ version: string; downloadAndInstall: typeof downloadAndInstall } | null> => ({
      version: "1.2.3",
      downloadAndInstall,
    }));
    const relaunch = mock(async () => {});

    mock.module("@tauri-apps/plugin-updater", () => ({ check }));
    mock.module("@tauri-apps/plugin-process", () => ({ relaunch }));

    const { checkForUpdate, downloadUpdate, relaunchApp } = await import("../../src/tauri/updater");

    const version = await checkForUpdate();
    expect(version).toBe("1.2.3");
    expect(check).toHaveBeenCalledTimes(1);

    await downloadUpdate(() => {});
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);

    await relaunchApp();
    expect(relaunch).toHaveBeenCalledTimes(1);

    check.mockImplementationOnce(async () => null);
    const noVersion = await checkForUpdate();
    expect(noVersion).toBeNull();

    await downloadUpdate(() => {});
    // No new update was found, so the stale handle from before must not be reused.
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
  });

  test("downloadUpdate translates plugin download events into 0–100 progress", async () => {
    const downloadAndInstall = mock(async (onEvent?: (e: DownloadEvent) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 200 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
      onEvent?.({ event: "Finished" });
    });
    const check = mock(async () => ({ version: "2.0.0", downloadAndInstall }));

    mock.module("@tauri-apps/plugin-updater", () => ({ check }));
    mock.module("@tauri-apps/plugin-process", () => ({ relaunch: mock(async () => {}) }));

    const { checkForUpdate, downloadUpdate } = await import("../../src/tauri/updater");

    await checkForUpdate();
    const progress: number[] = [];
    await downloadUpdate((p) => progress.push(p));
    expect(progress).toEqual([0, 50, 100, 100]);
  });
});
