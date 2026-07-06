# Lopload — agent guide

Tauri v2 + React 19 + TypeScript + `@cloudflare/kumo` + `@aws-sdk/client-s3`.

## Quick start

```sh
bun install
bun run tauri dev       # desktop app with hot-reload
bun run dev              # frontend only, browser tab (in-memory demo backend)
bun run check            # typecheck + unit tests
bun run test:integration # MinIO via docker (skipped if docker absent)
```

Everything uses `bun` — never `npm`/`npx`/`node`.

## Credential backend

Single native backend, selected at compile time per platform — no env vars, no config:

| Platform | Crate | Store |
|---|---|---|
| macOS | `security-framework` (standard `SecItemAdd`) | Data Protection Keychain (no prompts) |
| Windows | `keyring` with `windows-native` | Credential Manager |
| Linux | `keyring` with `sync-secret-service` | Secret Service (gnome-keyring / KWallet) |

## Architectural decisions

1. **S3 in the frontend** — `@aws-sdk/client-s3` with manual multipart. Fetch injected via `requestHandler` (Tauri HTTP plugin in app, global fetch in tests).
2. **No CORS** — the Tauri webview uses `@tauri-apps/plugin-http` which goes through Rust.
3. **SQLite** via `@tauri-apps/plugin-sql` for connection metadata + transfer state. **No secrets in SQLite.**
4. **Credentials** only in OS keychain. Never SQLite, config files, or logs.
5. **Transfer state machine**: `queued → sending → checking → uploaded | failed`. `failed` is sticky until user acts.
6. **Verification before "Uploaded ✓"**: local MD5 vs ETag (single) or HeadObject size+composite ETag (multipart).
7. **Error classes**: `offline`, `credentials`, `storage-full`, `connection-dropped`, `verification`, `not-found`, `unknown`. Raw SDK text never reaches the UI.
8. **Orphan sweep**: every 24h, abort multipart uploads >3d old with no local record. Silent.
9. **8 MiB parts**, 16 MiB multipart threshold.

## Directory layout

```
src/lib/            framework-free TS engine (S3, stores, state machine)
src/tauri/          thin wrappers around Tauri plugins (keychain, fs, HTTP, notifications)
src/services/       wires engine + Tauri into the AppServices contract
src/ui/             React components on Kumo, pastel palette
src-tauri/          Rust: plugins, keychain commands, tray, macOS entitlements
tests/unit/         bun test + happy-dom (no I/O)
tests/integration/  real MinIO via docker
```

## Testing

```sh
bun run check     # tsc --noEmit + bun test tests/unit src
bun run test:integration  # needs docker
```

Rust tests: `cd src-tauri && cargo test` (keychain tests that touch the real OS keychain are `#[ignore]`).

## Building for production

```sh
bun run tauri build
```

Credentials are always stored in the OS-native secure storage — no env vars, no build flags.

Set `signingIdentity` in `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity` for macOS code signing.

On Windows, `tauri build` produces:
- `.msi` — WiX installer
- `.exe` — NSIS installer (in `bundle/nsis/`)
- `Lopload_portable.exe` — raw binary, no install needed (copied into `bundle/msi/` by CI)

## Conventions

- No comments in source code unless the "why" isn't obvious from the code.
- UI strings say folder/file/storage — never bucket, object, key, prefix, ETag, multipart.
- React components: Kumo primitives, Tailwind, pastel tokens from `src/ui/theme.css`.
- TypeScript: strict mode, zod for validation where needed.
- Imports: path aliases not used — all imports are relative.
