import { useEffect, useState } from "react";
import { Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { useServices } from "./services";
import { useAutoUpdateContext } from "./AutoUpdateContext";
import { isPortable } from "../tauri/isPortable";
import type { TransferTuning } from "../lib/types";
import { DEFAULT_TUNING, PRESETS, presetMatching } from "./settings/presets";
import { GeneralPane } from "./settings/GeneralPane";
import { TransfersPane, type TuningKnob } from "./settings/TransfersPane";
import { UpdatesPane } from "./settings/UpdatesPane";
import { MaintenancePane } from "./settings/MaintenancePane";

type Category = "general" | "transfers" | "updates" | "maintenance";

const CATEGORIES: { id: Category; label: string }[] = [
  { id: "general", label: "General" },
  { id: "transfers", label: "Transfers" },
  { id: "updates", label: "Updates" },
  { id: "maintenance", label: "Maintenance" },
];

export interface SettingsDialogProps {
  onClose: () => void;
  /** Current connection, used for the "Clean up interrupted uploads" action.
   * Null renders that action disabled rather than hiding it. */
  connectionId: string | null;
}

export function SettingsDialog({ onClose, connectionId }: SettingsDialogProps) {
  const services = useServices();
  const { checkNow } = useAutoUpdateContext();
  const [category, setCategory] = useState<Category>("general");
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState<boolean>(true);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const [tuning, setTuningState] = useState<TransferTuning>(DEFAULT_TUNING);
  const [portable, setPortable] = useState(false);
  const [abortingStale, setAbortingStale] = useState(false);
  const [abortStaleResult, setAbortStaleResult] = useState<string | null>(null);

  useEffect(() => {
    void isPortable().then(setPortable);
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
      // Goes through the shared auto-update state so a found version surfaces
      // the same banner (Update → download → Restart) the automatic check
      // would, rather than dead-ending at this inline text.
      const found = await checkNow();
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

  async function handleKnobChange(knob: TuningKnob, value: unknown) {
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
      <Dialog className="flex h-[30rem] w-full sm:w-full max-w-3xl flex-col p-6">
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
        <div className="mt-4 flex min-h-0 flex-1 gap-6">
          <nav className="flex w-36 shrink-0 flex-col gap-0.5 border-r border-kumo-line pr-3">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                aria-current={category === c.id ? "true" : undefined}
                className={`rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                  category === c.id
                    ? "bg-kumo-tint font-medium text-kumo-strong"
                    : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                }`}
              >
                {c.label}
              </button>
            ))}
          </nav>
          <div
            className="-mr-4 min-h-0 flex-1 overflow-y-auto py-1 pr-4"
            style={{ scrollbarGutter: "stable" }}
          >
            {category === "general" && (
              <GeneralPane
                downloadDir={downloadDir}
                onPickDownloadDir={() => void handlePickDownloadDir()}
                onClearDownloadDir={() => void handleClearDownloadDir()}
              />
            )}
            {category === "transfers" && (
              <TransfersPane
                tuning={tuning}
                currentPreset={currentPreset}
                onPresetChange={(v) => void handlePresetChange(v)}
                onKnobChange={(knob, v) => void handleKnobChange(knob, v)}
              />
            )}
            {category === "updates" && (
              <UpdatesPane
                portable={portable}
                autoUpdateEnabled={autoUpdateEnabled}
                onToggleAutoUpdate={(enabled) => void handleToggleAutoUpdate(enabled)}
                checking={checking}
                checkResult={checkResult}
                onCheckNow={() => void handleCheckNow()}
              />
            )}
            {category === "maintenance" && (
              <MaintenancePane
                connected={connectionId !== null}
                cleaning={abortingStale}
                cleanupResult={abortStaleResult}
                onCleanUp={() => void handleAbortStaleUploads()}
              />
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
