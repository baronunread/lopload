# Lopload — agent guide

Native Rust desktop application built with GPUI and Cinder. Storage, transfer,
SQLite, and credential logic lives in `crates/lopload-native/`; the shipping UI
lives in `src-gpui/`.

The former Tauri + React implementation is retained temporarily as a legacy
reference and test corpus. Production development, CI, packaging, and releases
must use the GPUI path.

## Quick start

```sh
cargo install --git https://github.com/CapSoftware/cinder --rev 2a96b0551fd7bf1ae6e4115a74bfd33b078bb58a --locked cinder
bun install
bun run dev
bun run check
bun run build
bun run package
```

Everything invoked from the repository root uses `bun`; never use npm or npx.
Inside Rust crates, use Cinder for run/check/build/test/fmt commands.

## Credential backend

One native backend is selected at compile time per platform:

| Platform | Crate | Store |
|---|---|---|
| macOS | `security-framework` | Login keychain |
| Windows | `keyring` with `windows-native` | Credential Manager |
| Linux | `keyring` with `sync-secret-service` | Secret Service |

Credentials never belong in SQLite, config files, environment variables, or
logs.

## Architectural decisions

1. S3 operations run in native Rust through the AWS SDK.
2. SQLite stores connection metadata and transfer state, never secrets.
3. Transfers persist through `queued → sending → checking → uploaded | failed`.
4. Upload completion requires local MD5 versus server ETag verification.
5. Errors shown in the UI use the stable classes `offline`, `credentials`,
   `storage-full`, `connection-dropped`, `verification`, `not-found`, and
   `unknown`; raw SDK text never reaches users.
6. Updates come only from the configured HTTPS GitHub Release manifest and are
   Minisign-verified with the embedded public key before installation.

## Directory layout

```text
crates/lopload-native/  native S3, SQLite, keychain, settings, and transfers
src-gpui/               production GPUI application and package manifest
src-gpui/src/updater.rs signed update trust boundary
src-tauri/icons/        shared desktop and tray icon assets
src/                    legacy React implementation, not shipped
src-tauri/              legacy Tauri implementation, not shipped
tests/                  legacy Host-seam test corpus
```

## Testing

```sh
bun run check
cd crates/lopload-native && cinder test
cd src-gpui && cinder check && cinder test
```

Native S3 integration tests use a real MinIO container on port 9400. CI starts
MinIO and runs the ignored listing, transfer, move, and Trash scenarios. Tests
must assert against actual storage state rather than a fake service.

Linux keychain tests need a D-Bus session and an `org.freedesktop.secrets`
provider. Tests that touch the real OS keychain remain ignored unless that
environment is available.

## Building and releases

`bun run package` uses cargo-packager. Release CI produces:

- macOS: `.app`, `.dmg`, and a signed `.app.zip` updater bundle
- Windows: WiX `.msi`, NSIS `.exe`, and a portable `.exe`
- Linux: `.deb` and AppImage

Bump versions with `bun run set-version <x.y.z>`. Tagged CI builds signed
updater packages and generates `latest.json`; ordinary CI never needs the
private signing key.

## Conventions

- No comments in source unless the reason is not evident from the code.
- UI strings say folder, file, and storage—never bucket, object, key, prefix,
  ETag, or multipart.
- Keep native operations out of rendering code when they can live in
  `lopload-native`.
- Preserve existing user changes in a dirty worktree.
