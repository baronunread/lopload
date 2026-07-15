# Changelog

All notable changes to Lopload are documented here. Release binaries and full notes live on the [releases page](https://github.com/baronunread/lopload/releases).

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
