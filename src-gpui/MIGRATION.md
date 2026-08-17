# GPUI cutover status

This crate is the production native application. The Tauri and React implementation remains in the repository as a temporary legacy reference and test corpus, but production development, CI, packaging, and releases use GPUI.

## Implemented

- Native GPUI application lifecycle and window
- First-run setup and post-connection celebration handoff
- Live system light/dark appearance with a persisted manual override
- Lopload visual shell
- Native Home → Add storage navigation and application state
- Native connection form with masked secret entry and validation
- SQLite connection metadata with credentials stored only in the OS keychain
- In-place reuse of the shipped Tauri metadata database, including lossless `key`/`remote_key` transfer-schema migration
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
- Server-side multipart copies for large rename/Trash operations and selectable 1-hour, 1-day, or 7-day share links
- Native download-folder, automatic-update, transfer-speed, and interrupted-upload cleanup settings
- Live transfer-rate display and collapsible active/completed/failed summaries
- Cross-platform native completion notifications with one summary per transfer batch
- Bounded parallel multipart uploads and ranged downloads driven by the selected speed preset
- Manual retry for failed uploads and downloads, including persisted ranged-download recovery
- Native OS file drops onto the current folder
- Guarded recursive folder drops with symlink skipping and depth, item, and byte limits
- Name filtering and name/size/modified-date sorting
- File information and recursively calculated folder information
- Authenticated native image thumbnails with a 25 MB memory guard
- Multi-selection with guarded recursive bulk downloads and confirmed bulk Trash
- Conflict-checked single and bulk move-to-folder controls
- Internal drag-to-move for selected rows, folder targets, and the parent folder
- Item- and byte-weighted progress for recursive folder moves
- Item- and byte-weighted progress for Trash, restore, permanent delete, and empty Trash
- Optimistic folder creation, rename, Trash, and move mutations with rollback
- Credential re-entry and generation-guarded listing responses
- Deterministic Rustls/WebPKI networking verified against real MinIO
- Cinder run/check commands and version lockstep with the production app
- Native release manifest for macOS, Linux, and Windows packaging through Cinder
- Cross-platform tray with live transfer status, failure state, show, and explicit quit
- Reveal completed downloads in Finder, Explorer, or the Linux file manager
- Restore the last-used storage and folder at startup
- Silent 30-day Trash retention sweep at startup and every 24 hours
- Real-MinIO native scenarios for listing, folder markers, previews, transfers, resume, moves, Trash, restore, purge, and maintenance cleanup
- Isolated GPUI window harness with painted-control interaction and onboarding-form validation coverage
- Signed GitHub Release update checks, Minisign verification, platform installation, and relaunch
- Production CI and packaging matrices for Linux, macOS, and Windows

GPUI's `runtime_shaders` feature is enabled so local development works with
Apple Command Line Tools alone. Release builds can compile Metal shaders ahead
of time on machines with full Xcode once native packaging is introduced.

## Follow-up validation

- Dock/taskbar failure badge if GPUI exposes a cross-platform API; the tray already carries the failure count and state
- Continue expanding GPUI window-level interaction coverage as UI behavior changes
- Validate signing and installers on all three hosted CI operating systems after the branch is pushed
- Retire the preserved legacy Tauri/React sources and tests in a dedicated cleanup after the first GPUI release
