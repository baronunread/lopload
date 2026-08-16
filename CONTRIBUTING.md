# Contributing to Lopload

Thanks for your interest! Bug reports, feature requests, and PRs are all welcome.

## Development setup

You'll need [Bun](https://bun.sh), [Cinder](https://github.com/CapSoftware/cinder), and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform (Rust toolchain, plus platform WebView deps on Linux). Cinder currently has no stable release, so bootstrap the pinned revision once with Cargo:

```sh
cargo install --git https://github.com/CapSoftware/cinder --rev 2a96b0551fd7bf1ae6e4115a74bfd33b078bb58a --locked cinder
bun install
bun run tauri dev        # desktop app with hot-reload
```

Tauri uses Cinder as its Rust runner. Cargo remains the source of truth underneath it, and Cinder safely delegates unsupported commands and release builds back to Cargo.

Everything uses `bun` — never `npm`/`npx`/`node`.

> `bun run dev` starts Vite in a plain browser tab, but the real S3/keychain/transfer stack needs the Tauri webview — use `bun run tauri dev`.

## Before opening a PR

```sh
bun run check     # typecheck + the whole suite — must pass, CI gates on this
bun run selftest  # the same scenarios, inside the real Tauri binary (macOS/Linux/Windows — needs OS keychain)
```

Tests talk to a real MinIO, so Docker needs to be running. The container is
reused between runs, so you pay its ~2s startup once. `bun run selftest` boots
the actual app and drives it — that's the one that covers the Rust/IPC path, and
it's worth running before anything that touches transfers. On Linux it needs a
running Secret Service provider (gnome-keyring / KWallet).

- Branch off `main`; PRs require passing CI and one approving review.
- Keep PRs focused — one change per PR.
- Match the existing code style; there's no formatter config, TypeScript strictness is the contract.

## Architecture and conventions

[`AGENTS.md`](AGENTS.md) is the source of truth for architecture, directory layout, testing tiers, and the invariants that must hold (credentials only in the OS keychain, no raw SDK errors in the UI, verified uploads). Read it before making non-trivial changes.

## Security issues

Don't open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
