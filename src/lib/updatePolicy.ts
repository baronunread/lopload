// Pure decision logic for auto-update checking and banner copy. Framework-
// free and Tauri-free so it can be unit-tested without mocking the updater
// plugin. See src/tauri/updater.ts for the actual plugin calls.

/** How often to re-check for an update while the app stays open. Startup
 * always checks regardless of this (call shouldCheckForUpdate with
 * lastCheckedAt = null on first check). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Whether enough time has passed (or this is the first check) to check
 * for an update again. */
export function shouldCheckForUpdate(now: number, lastCheckedAt: number | null): boolean {
  if (lastCheckedAt === null) return true;
  return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/**
 * Where a found update is in the two-click flow:
 *  - "available": found, waiting for the user to start the download
 *  - "downloading": downloading + staging, progress in `percent`
 *  - "ready": staged on disk, waiting for the user to restart
 */
export type UpdatePhase = "available" | "downloading" | "ready";

/** Clamps a byte count to a whole-percent 0–100 against a (possibly unknown)
 * total. Returns 0 when the total isn't known yet, so the bar reads as "just
 * started" rather than jumping around. */
export function downloadPercent(downloadedBytes: number, totalBytes: number | null): number {
  if (!totalBytes || totalBytes <= 0) return 0;
  const pct = Math.round((downloadedBytes / totalBytes) * 100);
  return Math.max(0, Math.min(100, pct));
}

export interface UpdateBanner {
  title: string;
  body: string;
  /** Label for the primary action button, or null when the phase offers no
   * action (i.e. while downloading). */
  actionLabel: string | null;
}

/** Copy for the update banner, per phase. `hasTransfersInFlight` only changes
 * the wording; it never hides the action, so the user is always in control. */
export function buildUpdateBanner(
  phase: UpdatePhase,
  version: string,
  hasTransfersInFlight: boolean,
  percent = 0,
): UpdateBanner {
  switch (phase) {
    case "available":
      return {
        title: `Version ${version} is available`,
        body: "Downloading won't interrupt anything. You choose when to restart.",
        actionLabel: "Update",
      };
    case "downloading":
      return {
        title: "Downloading update…",
        body: `${percent}%`,
        actionLabel: null,
      };
    case "ready":
      return {
        title: `Version ${version} is ready`,
        body: hasTransfersInFlight
          ? "Restarting will interrupt your transfers, so they'll show as failed."
          : "Restart to finish updating.",
        actionLabel: "Restart now",
      };
  }
}
