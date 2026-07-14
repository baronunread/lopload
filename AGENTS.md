# Lopload — agent guide

Tauri v2 + React 19 + TypeScript + `@cloudflare/kumo` + `@aws-sdk/client-s3`.

## Quick start

```sh
bun install
bun run tauri dev       # desktop app with hot-reload
bun run dev              # Vite only, browser tab — shows a "requires the desktop app" notice
bun run check            # typecheck + the whole suite — CI gates on this
bun run selftest         # the scenarios, inside the real Tauri binary
```

Tests need Docker running (a real MinIO — see Testing below).

Everything uses `bun` — never `npm`/`npx`/`node`.

## Credential backend

Single native backend, selected at compile time per platform — no env vars, no config:

| Platform | Crate | Store |
|---|---|---|
| macOS | `security-framework` (standard `SecItemAdd`) | login keychain |
| Windows | `keyring` with `windows-native` | Credential Manager |
| Linux | `keyring` with `sync-secret-service` | Secret Service (gnome-keyring / KWallet) |

On macOS the login keychain's ACL trusts the app's code-signing identity, so
local builds are signed with the self-signed `Lopload Dev` identity
(`bundle.macOS.signingIdentity` in `tauri.conf.json`) — a stable identity
means updates keep keychain access without re-prompting. CI overrides to
ad-hoc signing via `APPLE_SIGNING_IDENTITY=-`. Migrating to the prompt-free
Data Protection keychain requires a provisioning profile (paid Developer ID),
tracked in the improvement plan.

## Architectural decisions

1. **S3 in the frontend** — `@aws-sdk/client-s3` with single-part uploads. Fetch injected via `requestHandler` (Tauri HTTP plugin in app, global fetch in tests).
2. **No CORS** — the Tauri webview uses `@tauri-apps/plugin-http` which goes through Rust.
3. **SQLite** via `@tauri-apps/plugin-sql` for connection metadata + transfer state. **No secrets in SQLite.**
4. **Credentials** only in OS keychain. Never SQLite, config files, or logs.
5. **Transfer state machine**: `queued → sending → checking → uploaded | failed`. Transient network errors fail the transfer immediately (sticky until the user acts).
6. **Verification before "Uploaded ✓"**: local MD5 vs ETag.
7. **Error classes**: `offline`, `credentials`, `storage-full`, `connection-dropped`, `verification`, `not-found`, `unknown`. Raw SDK text never reaches the UI.

## Directory layout

```
src/lib/            framework-free TS engine (S3, stores, state machine)
src/tauri/          thin wrappers around Tauri plugins (keychain, fs, HTTP, notifications)
src/services/       host.ts (the platform boundary) + real.ts (wires engine → AppServices)
src/ui/             React components on Kumo, pastel palette
src-tauri/          Rust: plugins, keychain commands, tray, macOS entitlements, fastfs + fasthttp (zero-copy file writes / request bodies over IPC)
tests/scenarios/    what the app does, driven through the real UI
tests/support/      MinIO, the Node host, fault injection, the app harness
tests/unit/         pure functions only
```

## Testing

**There are no fake services, and no fake bucket.** Tests run the real UI against
the real services against the real engine against a real MinIO. If you find
yourself writing a double for something the app owns, you're solving it wrong.

The one substitution boundary is `Host` (`src/services/host.ts`) — the ~12 things
that genuinely cannot run outside a webview (OS keychain, native dialogs, tray,
notifications, local fs, the Rust fetch path). It has two real implementations:
`createTauriHost()` for the app, `createNodeHost()` for tests. Everything above
it — `real.ts`, the engine, the S3 client, the React tree — is the same code in
both.

**Scenarios** (`tests/scenarios/`) are plain functions over a `ScenarioCtx`, not
bun tests, because the same file runs in two places:

```sh
bun test                   # Node host → MinIO. Seconds. The inner loop.
bun run selftest           # the REAL Tauri binary → real Rust IPC → MinIO.
bun run test:remote        # the same scenarios → a real R2/S3 bucket.
```

`test:remote` needs a `.env.remote` (see `.env.remote.example`) and runs nightly
in CI. It exists because MinIO is an excellent S3 impersonator right up until it
isn't — checksum middleware, ETag formats on multipart, redirects — and those
bugs are invisible to a local-only suite. It confines itself to
`lopload-test/<run>/` and deletes that prefix when it's done; it cannot touch a
key outside it.

Write a scenario once; both runners pick it up from `tests/scenarios/index.ts`.
Assert on the **bucket**, not just the DOM — `bucketProbe` reads the bucket with
its own S3 client, so a bug in the app's client can't hide itself.

**Arrange with real state; produce failures with faults.** To test an error path,
don't fake a service — inject a fault at the fetch seam (`tests/support/faultyFetch.ts`):
`s3Error` returns genuine S3 error XML (so `classifyError()` is really exercised),
`stall` opens a window for a cancel, `corruptEtag` / `truncateBody` break
verification.

MinIO (port 9400) is **persistent** — `ensureMinio()` reuses a healthy container
and never stops it, so only the first run of the day pays startup. Isolation
comes from `freshBucket()` per suite, not from restarting anything. Docker must
be running; the suite **fails** rather than skipping if it isn't, because a suite
that silently passes without its storage backend is worse than no suite at all.
`bun run minio:stop` tears it down.

`tests/unit/` is now only genuinely pure functions (error classification, MD5,
tuning, update policy, sort/filter, trash key parsing). No mocks, no I/O.

Rust tests: `cd src-tauri && cargo test` (keychain tests that touch the real OS
keychain are `#[ignore]`). These run in CI.

## Building for production

```sh
bun run tauri build
```

Credentials are always stored in the OS-native secure storage — no env vars, no build flags.

Set `signingIdentity` in `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity` for macOS code signing.

Bump the version with `bun run set-version <x.y.z>`. `package.json` is the single source of truth (`tauri.conf.json` points at it) and the Rust crate is kept in lockstep. CI runs it with no argument, reading the version from the pushed git tag.

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
