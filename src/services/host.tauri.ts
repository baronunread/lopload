// The production Host: the real webview, the real OS.
//
// This is the only file in the app that imports @tauri-apps/* alongside the
// engine. It carries no logic — every member is a direct hand-off to a
// src/tauri wrapper or a Tauri plugin. If you find yourself wanting to write
// an `if` in here, it belongs in LoploadServices instead, where both hosts
// exercise it.
import { invoke } from "@tauri-apps/api/core";
import { join as joinPath, tempDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readDir, size as fileSize, stat } from "@tauri-apps/plugin-fs";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

import { createLogger } from "../lib/logger";
import {
  loadDatabase,
  SqliteConnectionStore,
  SqliteTransferStore,
} from "../lib/stores/sqlite";
import type { ConnectionStore, TransferStore } from "../lib/types";
import { tauriFileReader, tauriFileWriter } from "../tauri/fs";
import { tauriFetch } from "../tauri/http";
import { keychainDelete, keychainGet, keychainSet } from "../tauri/keychain";
import { initFileLogSink } from "../tauri/logSink";
import {
  getDefaultDownloadDir,
  getLastConnectionId,
  getTransferTuning,
  isAutoUpdateEnabled,
  setAutoUpdateEnabled,
  setDefaultDownloadDir,
  setLastConnectionId,
  setTransferTuning,
} from "../tauri/settings";
import {
  onUploadFilesRequested,
  setTrayConnections,
  setTrayStatus,
} from "../tauri/tray";
import {
  checkForUpdate,
  downloadUpdate,
  installAndRelaunch,
  relaunchApp,
} from "../tauri/updater";
import type { Host } from "./host";

const log = createLogger("host");

/** True when running inside the Tauri webview (vs. a plain browser tab). Every
 * member of the Host below needs that webview, so this is the guard that says
 * whether createTauriHost() can be called at all. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createTauriHost(): Host {
  // One database, resolved once. LoploadServices awaits these freely, so the
  // memoization has to live here rather than at each call site.
  let dbPromise: ReturnType<typeof loadDatabase> | null = null;
  const getDb = () => (dbPromise ??= loadDatabase());

  let connectionsPromise: Promise<ConnectionStore> | null = null;
  let transfersPromise: Promise<TransferStore> | null = null;

  return {
    fetch: tauriFetch,

    keychain: {
      get: keychainGet,
      set: keychainSet,
      delete: keychainDelete,
    },

    stores: {
      connections: () =>
        (connectionsPromise ??= getDb().then((db) => new SqliteConnectionStore(db))),
      transfers: () =>
        (transfersPromise ??= getDb().then((db) => new SqliteTransferStore(db))),
    },

    files: {
      reader: tauriFileReader,
      writer: tauriFileWriter,
      readDir: async (path) => {
        const entries = await readDir(path);
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
      },
      isDirectory: async (path) => (await stat(path)).isDirectory,
      size: (path) => fileSize(path),
      tempDir,
      join: joinPath,
    },

    dialogs: {
      pickFiles: async () => {
        const selection = await openDialog({ multiple: true, directory: false });
        if (!selection) return [];
        return Array.isArray(selection) ? selection : [selection];
      },
      pickSaveDestination: async (defaultPath) => {
        return (await saveDialog({ defaultPath })) ?? null;
      },
      pickDirectory: async (defaultPath) => {
        const selection = await openDialog({
          multiple: false,
          directory: true,
          defaultPath,
        });
        if (!selection) return null;
        return Array.isArray(selection) ? (selection[0] ?? null) : selection;
      },
    },

    shell: {
      openPath: async (path) => {
        await openPath(path);
      },
      revealItemInDir: async (path) => {
        await revealItemInDir(path);
      },
    },

    tray: {
      setStatus: setTrayStatus,
      setConnections: setTrayConnections,
      setProgress: (fraction) => {
        void invoke("tray_set_progress", { fraction }).catch(() => {});
      },
      setBadgeCount: (count) => {
        void invoke("set_badge_count", { count }).catch(() => {});
      },
      onUploadFilesRequested,
    },

    settings: {
      isAutoUpdateEnabled,
      setAutoUpdateEnabled,
      getDefaultDownloadDir,
      setDefaultDownloadDir,
      getTransferTuning,
      setTransferTuning,
      getLastConnectionId,
      setLastConnectionId,
    },

    updates: {
      checkForUpdate,
      downloadUpdate,
      relaunchApp,
      installAndRelaunch,
    },

    notify: async (title, body) => {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      const granted =
        (await isPermissionGranted()) || (await requestPermission()) === "granted";
      if (!granted) return;
      sendNotification({ title, body });
    },

    onFileDrop: (cb) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;

      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          cb(event.payload.paths);
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch((err) => log.warn("drag-drop listener failed to attach", err));

      return () => {
        cancelled = true;
        unlisten?.();
      };
    },

    onFileDragHover: (cb) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;

      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            // Tauri reports physical pixels; DOM rects are CSS pixels.
            const scale = window.devicePixelRatio || 1;
            cb({
              x: event.payload.position.x / scale,
              y: event.payload.position.y / scale,
            });
          } else if (event.payload.type === "leave") {
            // "drop" deliberately emits nothing — see Host.onFileDragHover.
            cb(null);
          }
        })
        .then((fn) => {
          if (cancelled) fn();
          else unlisten = fn;
        })
        .catch((err) => log.warn("drag-hover listener failed to attach", err));

      return () => {
        cancelled = true;
        unlisten?.();
      };
    },

    initLogSink: initFileLogSink,
  };
}
