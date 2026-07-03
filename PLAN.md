# Lopload — implementation plan

Lopload (spec codename "Warren", see `warren-app-spec.md`) is a desktop file
manager for S3-compatible storage: Tauri v2 + React 19 + TypeScript +
`@cloudflare/kumo`. The spec is the source of truth for UX; this file is the
source of truth for architecture. **The app name everywhere is "lopload" / "Lopload" — never Warren.**

## Architecture decisions (settled — do not relitigate)

1. **S3 in the frontend** with `@aws-sdk/client-s3` and *manual* multipart
   (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`), per spec.
2. **CORS bypass**: the webview can't fetch arbitrary S3 endpoints. The S3
   client is constructed with a custom `requestHandler` (a `FetchHttpHandler`
   whose `fetch` is injected). In the app the injected fetch is
   `@tauri-apps/plugin-http`'s `fetch` (goes through Rust, no CORS); in tests
   it's global fetch or `aws-sdk-client-mock`. Everything takes fetch/client
   via dependency injection.
3. **Persistence**: SQLite via `@tauri-apps/plugin-sql`. TS code talks to a
   `TransferStore` / `ConnectionStore` interface; production impl wraps
   plugin-sql, tests use an in-memory impl. Tables:
   - `connections(id TEXT PK, name, endpoint, bucket, region NULL, last_prefix, created_at)`
     — **no secrets here**
   - `transfers(id TEXT PK, connection_id, key, local_path, size, part_size,
     upload_id NULL, state, error_class NULL, expected_md5 NULL, created_at, updated_at)`
   - `transfer_parts(transfer_id, part_number, etag, size, PRIMARY KEY(transfer_id, part_number))`
4. **Credentials** (access key + secret) live only in the OS keychain via
   Rust `keyring` crate exposed as Tauri commands:
   `keychain_set(connection_id, access_key, secret_key)`,
   `keychain_get(connection_id) -> {accessKey, secretKey}`,
   `keychain_delete(connection_id)`. Service name: `com.lopload.app`.
5. **Transfer state machine** (pure TS, exhaustively unit-tested):
   `queued → sending(percent) → checking → uploaded | failed(errorClass)`.
   `failed` is sticky until user acts (retry/dismiss). Retry of a multipart
   transfer resumes from persisted parts, verified via `ListParts` first.
6. **Verification before "Uploaded ✓"** (spec hard requirement):
   - single PUT: local MD5 (computed while streaming) must equal response ETag
   - multipart: `HeadObject` after complete; size must equal local size and
     ETag must match the `{md5-of-part-md5s}-{N}` composite we compute locally
   - any mismatch ⇒ `failed("verification")`, never `uploaded`.
7. **Orphan cleanup**: on app start and every 24h, `ListMultipartUploads`;
   abort uploads older than 3 days that have no row in `transfers` with a
   matching `upload_id`. Completely silent — no UI events, no logs surfaced.
8. **Error taxonomy** (`errorClass`): `offline`, `credentials`,
   `storage-full`, `connection-dropped`, `verification`, `not-found`,
   `unknown`. One mapper module translates SDK/HTTP errors → class → plain
   sentence. No raw SDK text ever reaches the UI.
9. **File reading**: local files are read in part-size chunks via
   `@tauri-apps/plugin-fs` (`open` + `read` with seek), never whole-file in
   memory. Part size 8 MiB, multipart threshold 16 MiB.
10. **Language rule**: UI strings say folder/file/storage — never bucket,
    object, key, prefix, ETag, multipart.

## Layout

```
src/
  lib/            # framework-free engine (agent A)
    types.ts      # shared contracts (already written — extend, don't break)
    errors.ts     # error classification + plain-language messages
    s3/           # client factory, multipart engine, verify, orphan sweep
    stores/       # TransferStore/ConnectionStore interfaces + sqlite + memory impls
    engine.ts     # TransferEngine: queue, concurrency (3), events
  tauri/          # thin wrappers around tauri APIs (keychain, fs chunks, notify, sql)
  ui/             # React components (agent C)
  App.tsx
src-tauri/        # Rust (agent B)
tests/
  unit/           # bun test, happy-dom (agent A/C)
  integration/    # MinIO via docker, tagged, skipped if docker absent (agent D)
```

## Testing (non-negotiable)

- Runner: **bun test** (`bunfig.toml` presets happy-dom + jest-dom already configured).
- Engine: unit tests with `aws-sdk-client-mock` — happy path, resume after
  simulated restart (state reloaded from store), truncated-upload ⇒
  verification failure, every error class mapping, orphan sweep (aborts only
  old+unknown), state-machine transition table.
- UI: @testing-library/react — status chips render exact labels from spec
  table, failed chip persists until acknowledged, switcher isolates state.
- Integration: docker MinIO (`minio/minio`), real multipart upload + kill/resume
  + verify + orphan abort. Auto-skip when docker unavailable.
- `bun run check` = typecheck + all unit tests; must pass before any agent reports done.

## Workstreams

- **A (engine)**: src/lib/**, src/tauri/** TS wrappers, unit tests
- **B (rust)**: src-tauri/** — plugins (sql, http, fs, dialog, notification,
  store, opener), keychain commands, tray with progress, drag-drop events,
  capabilities/permissions, `cargo check` green
- **C (ui)**: src/ui/**, App.tsx, Kumo theming per spec palette, component tests
- **D (integration)**: wiring, MinIO integration tests, `bun run tauri build`
  (debug) proof, README

## Spec fidelity checklist (verify at the end)

- [ ] exact five status states with labels from spec table
- [ ] failed state sticky in list + dock badge + native notification
- [ ] resumable across process restart (persisted uploadId + part ETags)
- [ ] silent orphan sweep
- [ ] test-connection = small write + delete, plain-language result
- [ ] per-connection last-folder memory
- [ ] breadcrumbs, right-click menu (rename/delete/new folder/copy link)
- [ ] no storage jargon anywhere in UI strings
- [ ] pastel token overrides + Nunito/Inter fonts
- [ ] thumbnails for images/videos
