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
- Deterministic Rustls/WebPKI networking verified against real MinIO
- Cinder run/check commands and version lockstep with the production app

GPUI's `runtime_shaders` feature is enabled so local development works with
Apple Command Line Tools alone. Release builds can compile Metal shaders ahead
of time on machines with full Xcode once native packaging is introduced.

## Required for parity

- Uploads, downloads, resumable multipart state, and verification
- Rename, move, trash, restore, share-link, and empty-trash flows
- Native file dialogs, drag and drop, tray, notifications, and auto-updates
- Persistent connection, settings, and transfer stores
- Scenario coverage equivalent to the current Host-seam suite
- macOS, Linux, and Windows packaging and signing
