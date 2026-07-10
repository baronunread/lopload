import { useEffect, useState } from "react";
import { Button, Dialog, Select, Switch } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useServices } from "./services";
import type { TransferPreset, TransferTuning } from "../lib/types";
import { DEFAULT_TUNING, PRESETS, presetMatching } from "./settings/presets";

const CONCURRENT_FILES_OPTIONS = range(1, 8);
const PARTS_IN_FLIGHT_OPTIONS = range(1, 16);
const DOWNLOAD_CONNECTIONS_OPTIONS = range(1, 16);
const PART_SIZE_OPTIONS = [8, 16, 32, 64];

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

const PRESET_LABELS: Record<TransferPreset, string> = {
  slow: "Slow",
  normal: "Normal",
  fast: "Fast",
  custom: "Custom",
};

export interface SettingsDialogProps {
  onClose: () => void;
  /** Current connection, used for the "Abort stale uploads" action. Null
   * hides that action (e.g. no connection selected yet). */
  connectionId: string | null;
}

export function SettingsDialog({ onClose, connectionId }: SettingsDialogProps) {
  const services = useServices();
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState<boolean>(true);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const [tuning, setTuningState] = useState<TransferTuning>(DEFAULT_TUNING);
  const [abortingStale, setAbortingStale] = useState(false);
  const [abortStaleResult, setAbortStaleResult] = useState<string | null>(null);

  useEffect(() => {
    void services.updates.isAutoUpdateEnabled().then(setAutoUpdateEnabledState);
    void services.settings.getDefaultDownloadDir().then(setDownloadDir);
    void services.settings.getTransferTuning().then(setTuningState);
  }, [services]);

  async function handleToggleAutoUpdate(enabled: boolean) {
    setAutoUpdateEnabledState(enabled);
    await services.updates.setAutoUpdateEnabled(enabled);
  }

  async function handleCheckNow() {
    setChecking(true);
    setCheckResult(null);
    try {
      const found = await services.updates.checkForUpdate();
      if (found) {
        setCheckResult(`Version ${found} is available.`);
      } else {
        setCheckResult("You're up to date.");
      }
    } catch {
      setCheckResult("Couldn't check for updates.");
    } finally {
      setChecking(false);
    }
  }

  async function handlePickDownloadDir() {
    const dir = await services.pickDownloadDirectory();
    if (dir) {
      setDownloadDir(dir);
      await services.settings.setDefaultDownloadDir(dir);
    }
  }

  async function handleClearDownloadDir() {
    setDownloadDir(null);
    await services.settings.setDefaultDownloadDir(null);
  }

  async function saveTuning(next: TransferTuning): Promise<void> {
    setTuningState(next);
    await services.settings.setTransferTuning(next);
  }

  async function handlePresetChange(value: unknown) {
    if (value !== "slow" && value !== "normal" && value !== "fast") return;
    await saveTuning(PRESETS[value]);
  }

  async function handleKnobChange(
    knob: "concurrentFiles" | "uploadPartsInFlight" | "downloadConnections" | "partSizeMiB",
    value: unknown,
  ) {
    if (typeof value !== "number") return;
    const knobs = { ...tuning, [knob]: value };
    await saveTuning({ ...knobs, preset: presetMatching(knobs) });
  }

  async function handleAbortStaleUploads() {
    if (!connectionId) return;
    setAbortingStale(true);
    setAbortStaleResult(null);
    try {
      const { aborted, errors } = await services.engine.abortStaleUploads(connectionId);
      if (aborted === 0 && errors === 0) {
        setAbortStaleResult("Nothing to clean up.");
      } else if (errors === 0) {
        setAbortStaleResult(`Cleaned up ${aborted} stale upload${aborted === 1 ? "" : "s"}.`);
      } else {
        setAbortStaleResult(
          `Cleaned up ${aborted}, ${errors} couldn't be cleaned up — try again later.`,
        );
      }
    } catch {
      setAbortStaleResult("Couldn't clean up stale uploads.");
    } finally {
      setAbortingStale(false);
    }
  }

  const currentPreset = presetMatching(tuning);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="flex h-[32rem] w-full max-w-md flex-col p-6">
        <div className="flex shrink-0 items-center gap-3">
          <Dialog.Title className="m-0">Settings</Dialog.Title>
          <Dialog.Close
            render={(p) => (
              <Button
                variant="ghost"
                shape="square"
                aria-label="Close"
                icon={XIcon}
                className="ml-auto"
                {...p}
              />
            )}
          />
        </div>
        <div
          className="mt-4 -ml-1 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto py-1 pr-4 pl-1"
          style={{ scrollbarGutter: "stable" }}
        >
          <section>
            <h2 className="mb-3 text-sm font-semibold text-kumo-strong">General</h2>
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1 text-sm text-kumo-default">Default download directory</p>
                <div className="flex items-center gap-2">
                  <Button variant="secondary" onClick={handlePickDownloadDir}>
                    {downloadDir ? "Change" : "Choose"}
                  </Button>
                  {downloadDir && (
                    <>
                      <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">
                        {downloadDir}
                      </span>
                      <Button variant="ghost" onClick={handleClearDownloadDir}>
                        Clear
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div>
                <p className="mb-1 text-sm text-kumo-default">Transfer speed</p>
                <Select
                  aria-label="Transfer speed"
                  value={currentPreset}
                  onValueChange={handlePresetChange}
                >
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
                  Controls how many files transfer at once. Use Advanced settings below to
                  fine-tune further.
                </p>
              </div>

              <details className="rounded-md border border-kumo-line p-3">
                <summary className="cursor-pointer text-sm font-medium text-kumo-strong">
                  Advanced settings
                </summary>
                <div className="mt-3 flex flex-col gap-4">
                  <div>
                    <p className="mb-1 text-sm text-kumo-default">Concurrent files</p>
                    <Select
                      aria-label="Concurrent files"
                      value={tuning.concurrentFiles}
                      onValueChange={(v) => void handleKnobChange("concurrentFiles", v)}
                    >
                      {CONCURRENT_FILES_OPTIONS.map((n) => (
                        <Select.Option key={n} value={n}>
                          {n}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <p className="mb-1 text-sm text-kumo-default">Upload parts per file</p>
                    <Select
                      aria-label="Upload parts per file"
                      value={tuning.uploadPartsInFlight}
                      onValueChange={(v) => void handleKnobChange("uploadPartsInFlight", v)}
                    >
                      {PARTS_IN_FLIGHT_OPTIONS.map((n) => (
                        <Select.Option key={n} value={n}>
                          {n}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <p className="mb-1 text-sm text-kumo-default">Download connections</p>
                    <Select
                      aria-label="Download connections"
                      value={tuning.downloadConnections}
                      onValueChange={(v) => void handleKnobChange("downloadConnections", v)}
                    >
                      {DOWNLOAD_CONNECTIONS_OPTIONS.map((n) => (
                        <Select.Option key={n} value={n}>
                          {n}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <p className="mb-1 text-sm text-kumo-default">Part size</p>
                    <Select
                      aria-label="Part size"
                      value={tuning.partSizeMiB}
                      onValueChange={(v) => void handleKnobChange("partSizeMiB", v)}
                    >
                      {PART_SIZE_OPTIONS.map((n) => (
                        <Select.Option key={n} value={n}>
                          {n} MiB
                        </Select.Option>
                      ))}
                    </Select>
                    <p className="mt-1 text-xs text-kumo-subtle">
                      Applies to transfers queued from now on — transfers already in progress
                      keep their original part size.
                    </p>
                  </div>
                </div>
              </details>
            </div>
          </section>

          <hr className="border-kumo-line" />

          <section>
            <h2 className="mb-3 text-sm font-semibold text-kumo-strong">Updates</h2>
            <Switch
              label="Check for updates automatically"
              checked={autoUpdateEnabled}
              onCheckedChange={handleToggleAutoUpdate}
              controlFirst={false}
            />
            <p className="mt-1 text-xs text-kumo-subtle">
              Manual check always works regardless of this setting.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Button variant="secondary" onClick={handleCheckNow} disabled={checking}>
                {checking ? "Checking…" : "Check for updates now"}
              </Button>
              {checkResult && (
                <span className="text-sm text-kumo-subtle tabular-nums">{checkResult}</span>
              )}
            </div>
          </section>

          {connectionId && (
            <>
              <hr className="border-kumo-line" />
              <section>
                <h2 className="mb-3 text-sm font-semibold text-kumo-strong">Storage</h2>
                <p className="mb-1 text-sm text-kumo-default">Abort stale uploads</p>
                <p className="mb-3 text-xs text-kumo-subtle">
                  Uploads interrupted by a crash or force-quit can leave unfinished data behind.
                  This cleans up anything left over from a failed transfer on this connection.
                </p>
                <div className="flex items-center gap-3">
                  <Button
                    variant="secondary"
                    onClick={handleAbortStaleUploads}
                    disabled={abortingStale}
                  >
                    {abortingStale ? "Cleaning up…" : "Abort stale uploads"}
                  </Button>
                  {abortStaleResult && (
                    <span className="text-sm text-kumo-subtle tabular-nums">
                      {abortStaleResult}
                    </span>
                  )}
                </div>
              </section>
            </>
          )}
        </div>

      </Dialog>
    </Dialog.Root>
  );
}
