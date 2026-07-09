// Thin wrapper around the tray IPC surface (src-tauri/src/tray.rs): pushes
// engine-derived status to the tray menu/icon. All tray business logic
// (formatting, icon choice) lives in Rust — this file only carries data
// across the IPC boundary.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createLogger } from "../lib/logger";

const log = createLogger("tray");

export interface TrayStatus {
  /** Number of transfers currently queued/sending/checking. */
  uploading: number;
  /** Overall progress across in-flight transfers, 0-100. */
  percent: number;
  /** Number of unacknowledged failed transfers. */
  failed: number;
}

export interface TrayUploadTarget {
  id: string;
  name: string;
}

const UPLOAD_FILES_EVENT = "tray://upload-files";

/** At most a few IPC calls per second — progress events fire far more often
 * than the tray menu needs to redraw. Leading call goes out immediately;
 * anything arriving within the window collapses into one trailing call. */
const THROTTLE_MS = 300;

let lastSentAt = 0;
let pendingStatus: TrayStatus | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function sendStatus(status: TrayStatus): void {
  lastSentAt = Date.now();
  void invoke("tray_set_status", {
    uploading: status.uploading,
    percent: status.percent,
    failed: status.failed,
}).catch((err) => log.warn("tray_set_status failed", err));
}

/** Pushes the tray's status line and Quit label to Rust, throttled so a
 * fast stream of progress updates doesn't spam IPC. */
export function setTrayStatus(status: TrayStatus): void {
  const now = Date.now();
  const elapsed = now - lastSentAt;
  if (elapsed >= THROTTLE_MS) {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
    sendStatus(status);
    return;
  }
  pendingStatus = status;
  if (!pendingTimer) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (pendingStatus) {
        sendStatus(pendingStatus);
        pendingStatus = null;
      }
    }, THROTTLE_MS - elapsed);
  }
}

/** Pushes the current saved connections to the tray's "Upload files…" submenu. */
export function setTrayConnections(connections: TrayUploadTarget[]): void {
  void invoke("tray_set_connections", { connections }).catch((err) => log.warn("tray_set_connections failed", err));
}

/** Subscribes to a per-connection "Upload files…" click; the callback
 * receives the connection id. Returns an unsubscribe. */
export function onUploadFilesRequested(cb: (connectionId: string) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;

  void listen<string>(UPLOAD_FILES_EVENT, (event) => cb(event.payload)).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
