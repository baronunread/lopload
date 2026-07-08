import { LazyStore } from "@tauri-apps/plugin-store";

const SETTINGS_PATH = "settings.json";

const store = new LazyStore(SETTINGS_PATH, {
  defaults: {
    autoUpdateEnabled: true,
    defaultDownloadDir: null,
    concurrentTransfers: 3,
  },
  autoSave: 100,
});

const AUTO_UPDATE_KEY = "autoUpdateEnabled";
const DOWNLOAD_DIR_KEY = "defaultDownloadDir";
const CONCURRENT_KEY = "concurrentTransfers";

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

export async function getConcurrentTransfers(): Promise<number> {
  const val = await store.get<number>(CONCURRENT_KEY);
  return val ?? 3;
}

export async function setConcurrentTransfers(count: number): Promise<void> {
  await store.set(CONCURRENT_KEY, count);
}


