// Pure logic backing the tray's "Upload files…" submenu (src/tauri/tray.ts +
// src/services/real.ts glue): deriving its contents from the saved
// connection list. No Tauri imports here so this can be unit tested without
// a webview.
import type { Connection } from "../lib/types";
import type { TrayUploadTarget } from "../tauri/tray";

/** Maps saved connections to the tray's "Upload files…" submenu items, one
 * per connection, in list order. */
export function deriveTrayUploadTargets(connections: Connection[]): TrayUploadTarget[] {
  return connections.map((c) => ({ id: c.id, name: c.name }));
}
