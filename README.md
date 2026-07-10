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
> Add credentials for one or more storage connections, then drag files in like any other file manager — Windows, macOS, and Linux. Nothing in the interface ever says "bucket," "object," or "key": these are just folders and files.

---

### Quick start

```bash
bun install
bun run tauri dev
```

> [!TIP]
> `bun run dev` starts Vite in a plain browser tab, but the app only renders a
> "requires the desktop app" notice there — the real S3/keychain/transfer
> stack needs the Tauri webview. Use `bun run tauri dev` to run the app.

| Platform | Download |
|---|---|
| macOS (Apple Silicon) | `.dmg` |
| Windows (x64) | `.msi` (installer) · `.exe` (portable) |
| Linux (x64) | `.deb` |

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
> **Production build** — `bun run tauri build` always stores credentials in the native OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service). No env vars, no config, no prompts.

---

### Auto updates

Lopload checks GitHub Releases for a new version on startup (and at most every 24h while it stays open), and offers a "restart to update" prompt — never a forced/silent update. Updates are signed with Tauri's free minisign keypair; there's no paid code-signing certificate involved. **This needs one-time setup before it works:**

1. **Generate the signing keypair** (once, on your machine — never commit the private key):
   ```sh
   bunx tauri signer generate -w ~/.tauri/lopload.key
   ```
   This prints a public key and writes the private key to `~/.tauri/lopload.key`. Optionally pass `-p` to set a password on the private key.

2. **Paste the public key** into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`, replacing the `REPLACE_WITH_TAURI_SIGNER_PUBLIC_KEY…` placeholder.

3. **Add GitHub Actions secrets** (repo → Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — the contents of `~/.tauri/lopload.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — only if you set a password in step 1

Until these are done, everyday CI builds (push/PR) are unaffected — they pass `--no-sign` and skip updater signing entirely. Only tag pushes (`v*`, i.e. actual releases) sign updater artifacts and need the secrets; that build step will fail until they're set. The very first tagged release after setup is what starts the update chain — every install after that can update from every subsequent release.

---

### Security

- Credentials live only in the OS keychain. Never in SQLite, config files, or logs.
- All S3 requests go through Rust via `@tauri-apps/plugin-http`. No CORS, no proxy, no third-party relay.
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
