// Transfer tuning presets — lives in src/lib (not src/ui) so both the
// engine/settings plumbing (src/tauri, src/services) and the UI (via
// src/ui/settings/presets.ts, which re-exports this) can share one
// definition without src/tauri depending on src/ui.
import type { TransferPreset, TransferTuning } from "./types";

type TuningKnobs = Omit<TransferTuning, "preset">;

const SLOW: TuningKnobs = {
  concurrentFiles: 1,
  uploadPartsInFlight: 2,
  downloadConnections: 2,
  partSizeMiB: 8,
};

const NORMAL: TuningKnobs = {
  concurrentFiles: 3,
  uploadPartsInFlight: 4,
  downloadConnections: 4,
  partSizeMiB: 8,
};

const FAST: TuningKnobs = {
  concurrentFiles: 4,
  uploadPartsInFlight: 8,
  downloadConnections: 8,
  partSizeMiB: 8,
};

export const PRESETS: Record<Exclude<TransferPreset, "custom">, TransferTuning> = {
  slow: { preset: "slow", ...SLOW },
  normal: { preset: "normal", ...NORMAL },
  fast: { preset: "fast", ...FAST },
};

export const DEFAULT_TUNING: TransferTuning = PRESETS.normal;

/** Pure: given a knob set (no `preset` field), returns the preset it
 * exactly matches, or "custom" if it matches none of Slow/Normal/Fast. */
export function presetMatching(knobs: TuningKnobs): TransferPreset {
  for (const name of ["slow", "normal", "fast"] as const) {
    const p = PRESETS[name];
    if (
      p.concurrentFiles === knobs.concurrentFiles &&
      p.uploadPartsInFlight === knobs.uploadPartsInFlight &&
      p.downloadConnections === knobs.downloadConnections &&
      p.partSizeMiB === knobs.partSizeMiB
    ) {
      return name;
    }
  }
  return "custom";
}
