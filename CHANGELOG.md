# Changelog

All notable changes to Lopload are documented here. Release binaries and full notes live on the [releases page](https://github.com/baronunread/lopload/releases).

## [0.2.0] — 2026-07-19

Faster browsing, faster trash, and a lot of UI polish.

- Dragging files onto the browser now shows an animated overlay that names the destination folder and highlights the exact folder row under the cursor, so it's clear where a drop will land.
- Navigation renders instantly from a session cache while a silent revalidate refreshes listings and folder stats in the background.
- Trash, restore, and permanent delete run much faster with bounded concurrency, stream progress through the transfer widget and Trash dialog, and write the Trash folder marker before children so Trash never shows loose files mid-operation.
- Settings is reorganized into a wider dialog with a sidebar (General, Transfers, Updates, Maintenance) and clearer descriptions.
- Long breadcrumbs collapse into Home + a "…" dropdown of hidden ancestors + the last two segments, so the toolbar actions stay visible.
- Right-clicked rows stay highlighted and hover is suppressed while a context menu is open.
- Thumbnails render a fixed icon from first paint and cross-fade in the image, so rows never shift as previews load; preview URLs are cached for the session.
- Files get per-type icons in the listing fallback and drag ghost.
- The native webview context menu is suppressed in release builds.
- Dialogs at small widths now fill the dialog frame, so forms like Add storage actually get the intended two-column layout.
- Date formats use numeric day/month/year to avoid ambiguous localized month abbreviations.
- The portable `.exe` no longer shows the auto-update toggle or runs periodic update checks — the bundled updater is tied to the installer.
- Bucket listings stay stable during transfers: a refresh that fails after a successful load keeps the existing rows instead of blanking the table.
- Transfer failures now reach the log file reliably, and DEBUG noise is dropped from the file sink so WARN/ERROR lines are easier to find.

## [0.1.3] — 2026-07-15

- Fixed: storage connection dropdown no longer shows unnecessary scrollbars on Windows and Linux.
- Rewrote the entire test suite to run against real MinIO instead of in-memory fakes. The same scenarios also run against real S3/R2 (`bun run test:remote`). All test doubles — 2,700 lines of fakes, stubs, and conformance checks — are gone.
- In-app self-test (`bun run selftest`) now runs the same scenarios inside the real Tauri binary, exercising Rust IPC, fasthttp, and the webview — not just the Node host.
- Services and engine: `dispose()` now fully stops all work; `real.ts` renamed to `appServices.ts`.
- Dependencies: Vite 7→8, TypeScript 5→7, `@vitejs/plugin-react` 4→6, `actions/checkout` 5→7.

## [0.1.2] — 2026-07-15

- Auto-updates now use a non-intrusive banner with a two-step flow: when a new version is found, download it in the background — with a progress bar and without interrupting your work — then restart on your own schedule. Previously it was a single "restart and update" prompt that did both at once.
- Uploads no longer slow the app to a crawl. Request bodies now take a fast native path instead of being serialized across the UI thread, mirroring the download speed-up from 0.1.1.

## [0.1.1] — 2026-07-14

- Moving a folder now runs in the background with progress in the transfer widget, instead of freezing the "Move here" dialog on a spinner. Large files copy part by part, so a multi-gigabyte move advances steadily rather than snapping 0% → 100%, and moves are no longer capped at 5 GB per file.
- Downloads no longer slow the app to a crawl: file data now takes a fast native path rather than being serialized across the UI thread. A download in progress writes to a temporary file that's put in place only once it completes, so an interrupted download never leaves a corrupt or half-written file at the destination.
- The setup field labeled "Storage name" is now "Bucket name", matching the value you copy from your provider's console.

## [0.1.0] — 2026-07-10

Initial public release.

- Multi-connection file manager for S3-compatible storage (R2, S3, B2, MinIO, …)
- Verified uploads: local MD5 checked against the server ETag after every transfer
- Sticky failures — failed transfers stay visible until acted on
- Recoverable trash instead of immediate deletes
- Presigned share links with configurable expiry
- Drag-and-drop uploads and moves
- Credentials stored only in the native OS keychain
- Signed auto-updates via GitHub Releases
