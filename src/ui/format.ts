// Plain-language formatting helpers. No storage jargon anywhere in here —
// see the jargon sweep test in tests/unit/ui/jargonSweep.test.tsx.
import type { Transfer, TransferState } from "../lib/types";

/** The exact five chip labels from the spec table — order matters for docs, not for logic. */
const STATUS_LABELS = {
  queued: "Queued",
  sending: "Uploading",
  checking: "Checking",
  uploaded: "Uploaded ✓",
  downloaded: "Downloaded ✓",
  failed: "Couldn't send",
} as const;

export type ChipVisual = "neutral" | "amber" | "amber-pulse" | "mint" | "coral";

export interface ChipInfo {
  /** data-state attribute value + exact rendered label. */
  state: TransferState["kind"];
  label: string;
  visual: ChipVisual;
}

/** Maps a TransferState to the exact label + visual treatment the spec
 * requires. `direction` (default "upload") only changes wording — the
 * visual treatment and data-state are identical for both directions. */
export function chipInfo(
  state: TransferState,
  direction: Transfer["direction"] = "upload",
): ChipInfo {
  const isDownload = direction === "download";
  switch (state.kind) {
    case "queued":
      return { state: "queued", label: STATUS_LABELS.queued, visual: "neutral" };
    case "sending":
      return {
        state: "sending",
        label: `${isDownload ? "Downloading" : STATUS_LABELS.sending} - ${Math.round(state.percent)}%`,
        visual: "amber",
      };
    case "checking":
      return { state: "checking", label: STATUS_LABELS.checking, visual: "amber-pulse" };
    case "uploaded":
      return { state: "uploaded", label: STATUS_LABELS.uploaded, visual: "mint" };
    case "downloaded":
      return { state: "downloaded", label: STATUS_LABELS.downloaded, visual: "mint" };
    case "failed":
      return {
        state: "failed",
        label: isDownload ? "Couldn't download" : STATUS_LABELS.failed,
        visual: "coral",
      };
  }
}

/** Scales `value` down by 1024 until it fits the largest matching unit. */
function scaleToUnit(value: number, units: readonly string[]): string {
  let scaled = value;
  let i = 0;
  while (scaled >= 1024 && i < units.length - 1) {
    scaled /= 1024;
    i++;
  }
  const rounded = Math.round(scaled * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 KB";
  return scaleToUnit(bytes, ["bytes", "KB", "MB", "GB", "TB"]);
}

export function formatDate(ms: number | undefined, locale?: string | string[]): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "—";
  if (bytesPerSec < 1) return "0 B/s";
  return scaleToUnit(bytesPerSec, ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"]);
}

/** Splits a remote key into breadcrumb segments, e.g. "a/b/c.txt" -> ["a", "b"]. */
export function segmentsForPrefix(prefix: string): string[] {
  return prefix.split("/").filter(Boolean);
}
