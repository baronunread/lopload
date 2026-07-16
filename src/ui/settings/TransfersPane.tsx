import { Select } from "@cloudflare/kumo";
import type { TransferPreset, TransferTuning } from "../../lib/types";

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

const CONCURRENT_FILES_OPTIONS = range(1, 8);
const PARTS_IN_FLIGHT_OPTIONS = range(1, 16);
const DOWNLOAD_CONNECTIONS_OPTIONS = range(1, 16);
const PART_SIZE_OPTIONS = [8, 16, 32, 64];

const PRESET_LABELS: Record<TransferPreset, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
  custom: "Custom",
};

export type TuningKnob =
  | "concurrentFiles"
  | "uploadPartsInFlight"
  | "downloadConnections"
  | "partSizeMiB";

export interface TransfersPaneProps {
  tuning: TransferTuning;
  currentPreset: TransferPreset;
  onPresetChange: (value: unknown) => void;
  onKnobChange: (knob: TuningKnob, value: unknown) => void;
}

/** Speed preset plus the always-visible Advanced knobs (no more <details>). */
export function TransfersPane({
  tuning,
  currentPreset,
  onPresetChange,
  onKnobChange,
}: TransfersPaneProps) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1 text-sm text-kumo-default">Transfer speed</p>
        <Select aria-label="Transfer speed" value={currentPreset} onValueChange={onPresetChange}>
          <Select.Option value="slow">{PRESET_LABELS.slow}</Select.Option>
          <Select.Option value="normal">{PRESET_LABELS.normal}</Select.Option>
          <Select.Option value="fast">{PRESET_LABELS.fast}</Select.Option>
          {currentPreset === "custom" && (
            <Select.Option value="custom" disabled>
              {PRESET_LABELS.custom}
            </Select.Option>
          )}
        </Select>
        <p className="mt-1 text-xs text-kumo-subtle">
          Controls how many files transfer at once. Use Advanced below to fine-tune further.
        </p>
      </div>

      <div className="rounded-md border border-kumo-line p-3">
        <h3 className="mb-3 text-sm font-medium text-kumo-strong">Advanced</h3>
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-1 text-sm text-kumo-default">Concurrent files</p>
            <Select
              aria-label="Concurrent files"
              value={tuning.concurrentFiles}
              onValueChange={(v) => onKnobChange("concurrentFiles", v)}
            >
              {CONCURRENT_FILES_OPTIONS.map((n) => (
                <Select.Option key={n} value={n}>
                  {n}
                </Select.Option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-kumo-subtle">
              How many files transfer at the same time. Higher can clear a batch faster but uses
              more memory and connections.
            </p>
          </div>
          <div>
            <p className="mb-1 text-sm text-kumo-default">Upload parts per file</p>
            <Select
              aria-label="Upload parts per file"
              value={tuning.uploadPartsInFlight}
              onValueChange={(v) => onKnobChange("uploadPartsInFlight", v)}
            >
              {PARTS_IN_FLIGHT_OPTIONS.map((n) => (
                <Select.Option key={n} value={n}>
                  {n}
                </Select.Option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-kumo-subtle">
              How many chunks of a single large upload send in parallel. More parts can speed up
              big files on fast connections.
            </p>
          </div>
          <div>
            <p className="mb-1 text-sm text-kumo-default">Download connections</p>
            <Select
              aria-label="Download connections"
              value={tuning.downloadConnections}
              onValueChange={(v) => onKnobChange("downloadConnections", v)}
            >
              {DOWNLOAD_CONNECTIONS_OPTIONS.map((n) => (
                <Select.Option key={n} value={n}>
                  {n}
                </Select.Option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-kumo-subtle">
              How many parallel connections a single download can use to pull data faster.
            </p>
          </div>
          <div>
            <p className="mb-1 text-sm text-kumo-default">Part size</p>
            <Select
              aria-label="Part size"
              value={tuning.partSizeMiB}
              onValueChange={(v) => onKnobChange("partSizeMiB", v)}
            >
              {PART_SIZE_OPTIONS.map((n) => (
                <Select.Option key={n} value={n}>
                  {n} MiB
                </Select.Option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-kumo-subtle">
              Bigger parts mean fewer requests; smaller parts recover faster from errors. Applies
              to newly queued transfers — ones already in progress keep their original part size.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
