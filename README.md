# Lopload

[![Build](https://github.com/baronunread/lopload/actions/workflows/build.yml/badge.svg)](https://github.com/baronunread/lopload/actions/workflows/build.yml)
[![Tauri](https://img.shields.io/badge/Tauri-2-8A2BE2?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-1.85-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-808080)](#)
[![License](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)

Lopload is a desktop file manager for S3-compatible storage. Add credentials
for one or more storage connections, then drag files into it like any other
file manager — Windows, macOS, and Linux. Nothing in the interface ever says
"bucket," "object," or "key": to the person using it, these are just folders
and files.

The full product vision (design principles, UX requirements, feature list)
lives in `warren-app-spec.md` — referred to throughout this repo as "the
product spec." The app itself, its bundle identifier, and every user-facing
string are "Lopload."

Built with Tauri v2, React 19, TypeScript, and `@cloudflare/kumo`.

## Why it's trustworthy by design

Cloud upload tools routinely fail in ambiguous ways — a transfer silently
stalls, or the app reports success when only part of a file actually
landed. Lopload is built so that can't happen quietly:

- **Every transfer shows one of exactly five states** — Queued, Sending
  (with a live percentage), Checking, Uploaded, or Couldn't send (sticky
  until you act on it) — never just a spinner with no context.
- **Nothing is marked "Uploaded" without verification**: a single-part
  upload's local MD5 must match the server's ETag; a multipart upload gets a
  follow-up `HeadObject` whose size and composite ETag must match what was
  actually sent. A network hiccup that truncates a transfer but still
  returns success from the SDK can never produce a false "done."
- **Large uploads are resumable, not just retryable**: multipart part ETags
  and the upload ID are persisted to disk as they're produced, so an app or
  machine restart resumes from the last completed part instead of starting
  over.
- **Orphaned multipart sessions clean themselves up invisibly** — a
  scheduled sweep aborts abandoned upload sessions on the server with no
  matching local record, with no UI event and no log surfaced (this is
  different from a failed transfer, which always stays visibly failed until
  you acknowledge it).

## Getting started

Requires [bun](https://bun.sh) and, for the desktop shell, a Rust toolchain
(`source $HOME/.cargo/env` if it's not already on your `PATH`) plus the
platform prerequisites in the
[Tauri v2 docs](https://v2.tauri.app/start/prerequisites/).

```sh
bun install
bun run tauri dev     # full desktop app, hot-reloading
bun run dev            # frontend only, in a plain browser tab (falls back
                        # to in-memory demo services — see App.tsx)
```

Everything here uses `bun` — never `npm`/`npx`/`node`.

## Credential storage

Credentials (S3 access key + secret key) **never** touch SQLite, config
files, or logs. The app uses two backends selected at build time:

| Build | Backend | OS keychain |
|---|---|---|
| `tauri dev` (debug) | File-based JSON (`dev-credentials.json`, 0600) | Never touched |
| `LOPLOAD_NATIVE_KEYCHAIN=1 tauri build` | OS keychain (`keyring` crate) | macOS Keychain / Windows Credential Manager / Linux Secret Service |

On macOS, development builds avoid Keychain popups entirely by using the
file-based backend — the Keychain is only used in properly signed production
builds (set `signingIdentity` in `src-tauri/tauri.conf.json`).

## Testing

```sh
bun run check            # typecheck + all unit tests (framework-free
                          # engine, Rust-wrapper glue, and Kumo UI)
bun run test:integration  # real MinIO via docker — see below
```

`test:integration` spins up a disposable `minio/minio` container, runs the
transfer engine and S3 client against it for real (multipart upload +
simulated-restart resume, byte-exact verification, a forced verification
failure, orphan-sweep abort semantics, and connection testing), and tears
the container down afterward. If docker isn't running, the suite logs a
clear skip message instead of failing — it never silently reports false
success.

Rust-side unit tests live alongside the code in `src-tauri/src/**` and run
via `cargo test`.

## Building

```sh
bun run build              # frontend only: tsc + vite build
bun run tauri build         # debug installer (uses dev credential backend)
LOPLOAD_NATIVE_KEYCHAIN=1 bun run tauri build  # production installer
```

The CI pipeline (`.github/workflows/build.yml`) builds all three platforms
on every push and creates a GitHub Release with artifacts when a tag `v*`
is pushed.

## Architecture

`PLAN.md` is the source of truth for architecture decisions and layout
(engine/, Rust backend, UI, and integration workstreams, plus the spec
fidelity checklist verified against the actual code). In short:

- `src/lib/` — framework-free TypeScript engine: S3 client factory and
  manual multipart upload/resume/verify, error classification, the
  transfer state machine, and the SQLite/in-memory store implementations.
- `src/tauri/` — thin wrappers around Tauri plugin APIs (keychain, file
  reads, HTTP, notifications).
- `src/services/real.ts` — wires the engine and Tauri wrappers into the
  `AppServices` contract the UI depends on (`src/ui/services.ts`); one
  `TransferEngine` per connection, created lazily.
- `src/ui/` — React components built on Kumo, themed per the product spec's
  pastel palette.
- `src-tauri/` — the Rust backend: plugin registration, OS keychain
  commands (gated behind `#[cfg(native_keychain)]`), tray progress,
  drag-drop capabilities, macOS entitlements.
- `tests/unit/` — bun test + happy-dom, no I/O.
- `tests/integration/` — real docker MinIO, see above.

## Security notes

- Access keys and secret keys live **only** in the OS keychain (via the
  Rust `keyring` crate, service name `com.lopload.app`) in production
  builds, or in a permissions-protected JSON file during development.
- SQLite (`plugin-sql`) stores only non-secret connection metadata
  (endpoint, bucket, display name, last-browsed folder) and transfer/part
  bookkeeping needed for resume.
- All S3 requests are signed and sent through a custom fetch handler
  (`@tauri-apps/plugin-http` in the app, so requests go through Rust and
  never hit browser CORS) — there is no proxy or third-party relay in the
  path between this app and your storage endpoint.
- Failure messages shown to the user are always translated to one plain
  sentence; raw SDK/XML error text and storage jargon never reach the UI.
