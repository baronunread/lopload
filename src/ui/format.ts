// Plain-language formatting helpers. No storage jargon anywhere in here —
// see the jargon sweep test in tests/unit/ui/jargonSweep.test.tsx.
import type { TransferState } from "../lib/types";

/** The exact five chip labels from the spec table — order matters for docs, not for logic. */
export const STATUS_LABELS = {
  queued: "Queued",
  sending: "Sending",
  checking: "Checking",
  uploaded: "Uploaded ✓",
  failed: "Couldn't send — tap to retry",
} as const;

export type ChipVisual = "neutral" | "amber" | "amber-pulse" | "mint" | "coral";

export interface ChipInfo {
  /** data-state attribute value + exact rendered label. */
  state: TransferState["kind"];
  label: string;
  visual: ChipVisual;
}

/** Maps a TransferState to the exact label + visual treatment the spec requires. */
export function chipInfo(state: TransferState): ChipInfo {
  switch (state.kind) {
    case "queued":
      return { state: "queued", label: STATUS_LABELS.queued, visual: "neutral" };
    case "sending":
      return {
        state: "sending",
        label: `${STATUS_LABELS.sending} — ${Math.round(state.percent)}%`,
        visual: "amber",
      };
    case "checking":
      return { state: "checking", label: STATUS_LABELS.checking, visual: "amber-pulse" };
    case "uploaded":
      return { state: "uploaded", label: STATUS_LABELS.uploaded, visual: "mint" };
    case "failed":
      return { state: "failed", label: STATUS_LABELS.failed, visual: "coral" };
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 KB";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = i === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export function formatDate(ms: number | undefined): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi)$/i;

export function isImageName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/** Splits a remote key into breadcrumb segments, e.g. "a/b/c.txt" -> ["a", "b"]. */
export function segmentsForPrefix(prefix: string): string[] {
  return prefix.split("/").filter(Boolean);
}
