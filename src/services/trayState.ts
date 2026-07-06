// Pure logic backing the tray's two quick actions (src/tauri/tray.ts +
// src/services/real.ts glue): deriving the "Upload files…" submenu contents
// from the saved connection list, and tracking which upload the "Copy
// link — <file>" item should point at. No Tauri imports here so this can be
// unit tested without a webview.
import type { Connection, EngineEvent } from "../lib/types";
import type { TrayUploadTarget } from "../tauri/tray";

/** Maps saved connections to the tray's "Upload files…" submenu items, one
 * per connection, in list order. */
export function deriveTrayUploadTargets(connections: Connection[]): TrayUploadTarget[] {
  return connections.map((c) => ({ id: c.id, name: c.name }));
}

export interface LastUploadedFile {
  connectionId: string;
  key: string;
  name: string;
}

function basename(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Reducer for the "most recently verified upload" the tray's "Copy link"
 * item tracks: cleared the moment a fresh upload batch starts (a transfer is
 * freshly queued), replaced whenever a newer upload finishes verification.
 * Downloads and unrelated updates leave it untouched. */
export function trackLastUploaded(
  current: LastUploadedFile | null,
  event: EngineEvent,
): LastUploadedFile | null {
  if (event.type !== "transfer-updated") return current;
  const { transfer } = event;
  if (transfer.direction !== "upload") return current;

  const isFreshlyQueued = transfer.state.kind === "queued" && transfer.createdAt === transfer.updatedAt;
  if (isFreshlyQueued) return null;

  if (transfer.state.kind === "uploaded") {
    return { connectionId: transfer.connectionId, key: transfer.key, name: basename(transfer.key) };
  }

  return current;
}
