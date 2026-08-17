<p align="center">
  <a href="https://lopload.com">
    <picture>
      <source srcset="public/logo-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="public/logo-light.svg" media="(prefers-color-scheme: light)">
      <img src="public/logo-light.svg" width="120" alt="Lopload logo">
    </picture>
  </a>
</p>

<p align="center">A desktop file manager for S3-compatible storage.</p>

<p align="center">
  <a href="https://github.com/baronunread/lopload/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/baronunread/lopload/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/baronunread/lopload/releases"><img alt="Release" src="https://img.shields.io/github/v/release/baronunread/lopload?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="https://docs.lopload.com">Docs</a> •
  <a href="#security">Security</a>
</p>

[![Screenshot](media/screenshot.png)](https://lopload.com)

> [!TIP]
> S3 stands for *Simple* Storage Service — Lopload holds it to that. Add credentials for one or more storage connections, then drag files in like any other file manager — Windows, macOS, and Linux: just folders and files.

---

### Quick start

Install [Cinder](https://github.com/CapSoftware/cinder) once. Cinder is not yet distributed as a stable release, so Lopload pins the revision it uses:

```bash
cargo install --git https://github.com/CapSoftware/cinder --rev 2a96b0551fd7bf1ae6e4115a74bfd33b078bb58a --locked cinder
bun install
bun run dev
```

The desktop application is native Rust rendered by GPUI; it does not embed a webview. Useful commands are:

```bash
bun run check
bun run build
bun run package
```

The shipping UI lives in `src-gpui/`; reusable storage, transfer, SQLite, and keychain code lives in `crates/lopload-native/`.

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows (x64) | `.msi` · NSIS `.exe` · portable `.exe` |
| Linux (x64) | `.deb` · `.AppImage` |

Download from the [releases page](https://github.com/baronunread/lopload/releases).

> [!NOTE]
> macOS builds are not notarized yet, so Gatekeeper will warn on first launch.
> Right-click the app → **Open** (once), or clear the quarantine flag:
> `xattr -dr com.apple.quarantine /Applications/Lopload.app`

---

### Features

- **Verified uploads** — every file is checked after transfer: local MD5 vs server ETag. A network hiccup that truncates a transfer can never produce a false "done."
- **Sticky failures** — failed transfers stay visible until you act on them. No auto-dismiss, no silent retry.
- **Multi-connection** — switch between storage endpoints. Each remembers its last-browsed folder.
- **Recoverable trash** — deletes move files to a Trash you can restore from, instead of destroying them immediately.
- **Share links** — generate a presigned link with a picked expiry, right from the file row.
- **Drag-and-drop moves** — drag files onto folders or breadcrumbs to move them, with a live drop-target indicator.
- **Follows system theme** — light/dark follows the OS by default, with a manual toggle in the header.

> [!TIP]
> **Production build** — `bun run package` always stores credentials in the native OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service). No env vars or config files hold secrets.

---

### Auto updates

Lopload checks GitHub Releases on startup when automatic checks are enabled, and also offers a manual check in Settings. When a newer version is found, a banner lets you install and restart. Updates are never installed silently. Every downloaded installer is verified with the Minisign public key embedded in `src-gpui/src/updater.rs` before it can run. Linux AppImages update in place; `.deb` installations remain under their package manager's control.

<details>
<summary><strong>Running a fork?</strong> One-time signing setup</summary>

Tagged release builds (`v*`) sign updater artifacts with a private key held in this repo's CI secrets, so a fork needs its own keypair:

1. **Generate the keypair** (once, on your machine — never commit the private key):
   ```sh
   cargo-packager signer generate --path ~/.cargo/lopload.key
   ```
   This prints a public key and writes the private key to `~/.tauri/lopload.key`. Optionally pass `-p` to set a password on the private key.

2. **Paste the decoded Minisign public key** and your fork's `latest.json` URL into `src-gpui/src/updater.rs`.

3. **Add GitHub Actions secrets** (repo → Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of `~/.tauri/lopload.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — only if you set a password in step 1

Everyday push/PR builds work without these secrets; only tagged releases sign updater packages.
</details>

---

### Security

- Credentials live only in the OS keychain. Never in SQLite, config files, or logs.
- All S3 requests run in native Rust. No CORS workaround, webview bridge, proxy, or third-party relay is involved.
- Error messages shown to the user are plain sentences. Raw SDK or XML error text never reaches the UI.
- Found a vulnerability? Report it privately — see [`SECURITY.md`](SECURITY.md).
- [Documentation](https://docs.lopload.com) *(coming soon)*

---

### Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to get started, and [`AGENTS.md`](AGENTS.md) for architecture, commands, and conventions.

<p align="center">
  <a href="https://github.com/baronunread/lopload">GitHub</a> •
  <a href="https://docs.lopload.com">Docs</a>
</p>
