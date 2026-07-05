# Lopload

[![Build](https://github.com/baronunread/lopload/actions/workflows/build.yml/badge.svg)](https://github.com/baronunread/lopload/actions/workflows/build.yml)
[![Tauri](https://img.shields.io/badge/Tauri-2-8A2BE2?logo=tauri&logoColor=white)](https://v2.tauri.app)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-1.85-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3-000000?logo=bun&logoColor=white)](https://bun.sh)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-808080)](#)
[![License](https://img.shields.io/badge/license-MIT-3DA639)](LICENSE)

A desktop file manager for S3-compatible storage. Drag files in, they upload. Nothing in the interface ever says "bucket" or "object" — these are just folders and files.

## Quick start

```sh
bun install
bun run tauri dev
```

> **Dev mode** — runs in a browser tab (`bun run dev`) with a demo backend (seeded files, simulated uploads). No Tauri, no S3 needed.

> **Production build** — `LOPLOAD_NATIVE_KEYCHAIN=1 bun run tauri build` enables native OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service). Debug builds use a local JSON file and never touch the keychain.

## Why it's trustworthy

Every transfer goes through `queued → sending → checking → uploaded ✓` (or `failed`). Nothing is marked uploaded without verification — local MD5 must match the server's ETag. Multipart uploads resume across restarts. Failed transfers stay visible until you act on them.

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Frontend only (browser tab, demo backend) |
| `bun run tauri dev` | Desktop app with hot-reload |
| `bun run check` | TypeScript check + unit tests |
| `bun run test:integration` | Integration tests (real MinIO via Docker) |
| `bun run tauri build` | Debug installer (dev credential backend) |
| `LOPLOAD_NATIVE_KEYCHAIN=1 bun run tauri build` | Production installer (OS keychain) |

> **CI** — pushes to `main` build all three platforms. Push a tag `v*` to create a GitHub Release with `.deb`, `.dmg`, and `.msi` artifacts.

## Security

- Credentials live only in the OS keychain (or dev store in debug builds). Never in SQLite, config files, or logs.
- All S3 requests go through Rust (`@tauri-apps/plugin-http`). No CORS, no proxy, no third-party relay.
- Error messages shown to the user are plain sentences. Raw SDK or XML error text never reaches the UI.
