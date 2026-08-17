# GPUI migration status

This crate is the experimental native replacement for the Tauri and React application. The existing app remains the production implementation until the native path reaches behavioral parity.

## Implemented

- Native GPUI application lifecycle and window
- Lopload visual shell
- Native Home → Add storage navigation and application state
- Native connection form with masked secret entry and validation
- SQLite connection metadata with credentials stored only in the OS keychain
- Shared native keychain crate used by both the GPUI and Tauri targets
- Complete native connection schema, connection removal, and last-folder persistence
- Connection editing, optional credential replacement, and live connection testing
- Live paginated S3-compatible listing with folder navigation and refresh
- Native folder creation and plain-language storage errors
- Native file-picker uploads and save-dialog downloads with persisted transfer state
- Single-part and resumable multipart uploads with ETag verification, tested against real MinIO
- Startup recovery and manual retry for interrupted multipart uploads
- Persisted ranged downloads with size and plain-MD5 verification and temporary-file commits
- File and folder rename, confirmed Trash moves, restore, permanent delete, and empty-Trash flows
- Server-side multipart copies for large rename/Trash operations and 24-hour share links
- Native download-folder, automatic-update, and transfer-speed settings
- Bounded parallel multipart uploads and ranged downloads driven by the selected speed preset
- Deterministic Rustls/WebPKI networking verified against real MinIO
- Cinder run/check commands and version lockstep with the production app

GPUI's `runtime_shaders` feature is enabled so local development works with
Apple Command Line Tools alone. Release builds can compile Metal shaders ahead
of time on machines with full Xcode once native packaging is introduced.

## Required for parity

- Manual retry for interrupted downloads
- Move-to-folder controls and progress for recursive storage operations
- Native drag and drop, tray, notifications, and auto-updates
- Scenario coverage equivalent to the current Host-seam suite
- macOS, Linux, and Windows packaging and signing
