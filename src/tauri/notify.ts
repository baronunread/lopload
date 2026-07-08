// Thin wrapper around @tauri-apps/plugin-notification for the "N files
// uploaded" / "1 file failed" native notifications (spec: "Runs unattended,
// reports back when done").

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  const permission = await requestPermission();
  return permission === "granted";
}

export async function notifyBatchFinished(uploaded: number, failed: number): Promise<void> {
  if (uploaded === 0 && failed === 0) return;
  if (!(await ensurePermission())) return;

  const parts: string[] = [];
  if (uploaded > 0) {
    parts.push(`${uploaded} file${uploaded === 1 ? "" : "s"} uploaded`);
  }
  if (failed > 0) {
    parts.push(`${failed} file${failed === 1 ? "" : "s"} failed`);
  }

  sendNotification({ title: "Lopload", body: parts.join(" - ") });
}
