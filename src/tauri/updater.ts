// Thin wrapper around @tauri-apps/plugin-updater + @tauri-apps/plugin-process.
// Holds the last `Update` handle returned by check() so downloadUpdate() and
// relaunchApp() don't need callers to thread it through, mirroring the
// single-purpose module style of notify.ts. Decision logic (when to check,
// what to say) lives in src/lib/updatePolicy.ts, kept framework- and
// Tauri-free; we borrow its downloadPercent() helper here only to translate
// the plugin's byte-counting download events into a percentage.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { downloadPercent } from "../lib/updatePolicy";

let pendingUpdate: Update | null = null;

/** Checks for a new release. Resolves with its version string if one is
 * available, otherwise null. */
export async function checkForUpdate(): Promise<string | null> {
  const update = await check();
  pendingUpdate = update;
  return update ? update.version : null;
}

/** Downloads and stages the update found by the last checkForUpdate() call,
 * reporting progress (0–100) via onProgress as bytes arrive. Does NOT
 * relaunch; call relaunchApp() once the user is ready. No-op if there's
 * nothing pending (e.g. called before any check found an update). */
export async function downloadUpdate(onProgress: (percent: number) => void): Promise<void> {
  if (!pendingUpdate) return;
  let total: number | null = null;
  let downloaded = 0;
  await pendingUpdate.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? null;
        onProgress(0);
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress(downloadPercent(downloaded, total));
        break;
      case "Finished":
        onProgress(100);
        break;
    }
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}

export async function installAndRelaunch(): Promise<void> {
  await downloadUpdate(() => {});
  await relaunchApp();
}
