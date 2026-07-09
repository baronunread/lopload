import { LazyStore } from "@tauri-apps/plugin-store";

import type { TransferTuning } from "../lib/types";
import { DEFAULT_TUNING, presetMatching } from "../lib/tuning";

const SETTINGS_PATH = "settings.json";

const store = new LazyStore(SETTINGS_PATH, {
  defaults: {
    autoUpdateEnabled: true,
    defaultDownloadDir: null,
  },
  autoSave: 100,
});

const AUTO_UPDATE_KEY = "autoUpdateEnabled";
const DOWNLOAD_DIR_KEY = "defaultDownloadDir";
const TUNING_KEY = "transferTuning";
/** Pre-tuning-model setting (a single 1-5 concurrency knob). Read once, for
 * migration into transferTuning on first read after upgrade — never written
 * again. */
const LEGACY_CONCURRENT_KEY = "concurrentTransfers";

export async function isAutoUpdateEnabled(): Promise<boolean> {
  const val = await store.get<boolean>(AUTO_UPDATE_KEY);
  return val ?? true;
}

export async function setAutoUpdateEnabled(enabled: boolean): Promise<void> {
  await store.set(AUTO_UPDATE_KEY, enabled);
}

export async function getDefaultDownloadDir(): Promise<string | null> {
  const val = await store.get<string | null>(DOWNLOAD_DIR_KEY);
  return val ?? null;
}

export async function setDefaultDownloadDir(path: string | null): Promise<void> {
  await store.set(DOWNLOAD_DIR_KEY, path);
}

/** Pure: derives a full TransferTuning from the legacy single-knob
 * concurrency setting, defaulting every other knob to Normal. Exported so
 * the migration mapping can be unit tested without a live store. */
export function tuningFromLegacyConcurrency(concurrentFiles: number): TransferTuning {
  const knobs = {
    concurrentFiles,
    uploadPartsInFlight: DEFAULT_TUNING.uploadPartsInFlight,
    downloadConnections: DEFAULT_TUNING.downloadConnections,
    partSizeMiB: DEFAULT_TUNING.partSizeMiB,
  };
  return { preset: presetMatching(knobs), ...knobs };
}

export async function getTransferTuning(): Promise<TransferTuning> {
  const stored = await store.get<TransferTuning>(TUNING_KEY);
  if (stored) return stored;

  const legacy = await store.get<number>(LEGACY_CONCURRENT_KEY);
  if (typeof legacy === "number") {
    const migrated = tuningFromLegacyConcurrency(legacy);
    await store.set(TUNING_KEY, migrated);
    return migrated;
  }

  return DEFAULT_TUNING;
}

export async function setTransferTuning(tuning: TransferTuning): Promise<void> {
  await store.set(TUNING_KEY, tuning);
}
