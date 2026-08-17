# Contributing to Lopload

Thanks for your interest! Bug reports, feature requests, and PRs are all welcome.

## Development setup

You'll need [Bun](https://bun.sh), Rust, and [Cinder](https://github.com/CapSoftware/cinder). Cinder currently has no stable release, so bootstrap the pinned revision once with Cargo:

```sh
cargo install --git https://github.com/CapSoftware/cinder --rev 2a96b0551fd7bf1ae6e4115a74bfd33b078bb58a --locked cinder
bun install
bun run dev              # native GPUI app with hot-reload
```

Cinder drives the GPUI application while Cargo remains the source of truth underneath it.

Everything uses `bun` — never `npm`/`npx`/`node`.

## Before opening a PR

```sh
bun run check
```

Ignored native integration tests talk to a real MinIO, so Docker needs to be running when you exercise those scenarios. CI runs them against an actual MinIO container. On Linux, keychain tests need a running Secret Service provider such as gnome-keyring or KWallet.

- Branch off `main`; PRs require passing CI and one approving review.
- Keep PRs focused — one change per PR.
- Match the existing Rust style and run `cinder fmt` before submitting.

## Architecture and conventions

[`AGENTS.md`](AGENTS.md) is the source of truth for architecture, directory layout, testing tiers, and the invariants that must hold (credentials only in the OS keychain, no raw SDK errors in the UI, verified uploads). Read it before making non-trivial changes.

## Security issues

Don't open public issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
