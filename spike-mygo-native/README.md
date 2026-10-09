# Lopload native storage manager spike

MyGo **v0.3.7** draws the native UI. Embedded **rclone v1.75.2** provides the storage engine. There is no webview, JavaScript runtime, rclone sidecar, or local HTTP control server. Provider sessions outlive individual transfer contexts and are canceled when changing storage or closing the window. Production Lopload remains unchanged on `main`.

The macOS build registers **69 rclone backends**, including virtual backends such as aliases. Registration is not a claim that every provider has been tested: this spike exercises real S3-compatible storage (MinIO), local storage, and a configured alias.

## What works

- Browse folders, search, keyboard selection, and a virtualized file list.
- Connect directly to S3-compatible storage, select a local folder, or open an existing named rclone connection.
- Upload with progress and cancellation. The direct S3 connection uses multipart uploads above 8 MiB, two workers, and 8 MiB parts; the previous 5 GiB single-request restriction is removed. Configured connections use their own rclone options.
- Verify uploads with a local SHA-256 and a complete remote readback before showing `Uploaded ✓`. This deliberately replaces the earlier S3-specific ETag check in the spike; it also works with providers without a suitable exposed checksum. It costs an additional full download of each uploaded file.
- Download files through a native save dialog, compare size when available and provider MD5 when available, and publish the temporary download only after checks succeed.
- Copy and rename individual files. rclone can use server-side copying or its fallback. Both paths verify the destination through SHA-256 readback. Rename removes the original only after destination verification; it is not an atomic transaction.
- Create folders and delete individual files. The native delete dialog defaults to Cancel.
- Reject existing destination files during preflight rather than silently replace them. Downloads also reject an existing local destination. These checks are not a lock against another process writing concurrently.

## Run

With Go 1.27.2 or newer, from this directory:

```sh
go tool mygo dev
go tool mygo build
```

The build uses the local `Lopload Dev` signing identity. On another machine, `go tool mygo build -sign -` produces an ad hoc signature. This development build is not notarized for public distribution.

For local storage, choose **Local folder**, then select or enter a folder and connect. For an existing rclone connection, choose **Configured storage**, select **Reload configured storage**, and enter a location such as `my-drive:Documents`. Set up that profile and provider authorization with `rclone config` first; the running app does not require the rclone executable. The shared configuration path and any encrypted-config password follow rclone's normal configuration rules. Interactive terminal password prompts are disabled.

Select a file, enter a new name, and use Copy or Rename. New folder uses the same name field. Folder recursion and bulk selection are not implemented.

## Credential storage

The direct S3 connection still uses this spike's OS keychain service, `lopload-native-spike`. Selecting a local folder or named profile saves its connection descriptor through the same existing persistence path. Existing production credentials are not migrated.

Named rclone connections obtain credentials from rclone's shared configuration. Provider token refresh may update that configuration through rclone. This integration does not create a new app-owned plaintext credential file or replace the direct S3 keychain implementation. The earlier discussion of a complete plaintext migration remains a separate product decision.

## Tests

Start the repository's persistent test MinIO on port 9400 (`bun test` from the repository root starts it when Docker is running). Then:

```sh
cd spike-mygo-native
go test -race -v ./...
```

Tests use real MinIO, real temporary local folders, the real OS keychain, and the actual native view. There are no storage or engine doubles. Each S3 test owns a fresh test bucket and cleans it up. The dummy keychain round-trip restores any pre-existing spike connection; production credentials are never accessed.

Scenarios verify stored bytes through a separate MinIO SDK client, real multipart ETags, multipart cancellation without orphaned parts, folder listings, download bytes, copy/rename/delete, empty-folder creation, collision rejection, unsafe destination names, a temporary configured rclone alias, native search, and keyboard selection in a virtualized 10,000-row list. A proxy corrupts one byte of a genuine MinIO GET response to check that readback verification fails.

Linux and Windows also compile with all providers and without cgo:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/lopload-rclone-linux .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o /tmp/lopload-rclone-windows.exe .
```

Those platforms have not been launched. Native file dialogs, delete confirmation, provider OAuth refresh, and full manual click-through have not been driven; the corresponding storage operations and the native search/selection view are tested.

## Loaded-app benchmark

```sh
go tool mygo build
python3 measure.py build/darwin-arm64/spike-mygo-native.app/Contents/MacOS/spike-mygo-native /tmp/lopload-rclone-results
```

`--benchmark` creates a unique local MinIO bucket with 1,000 real empty files, displays the native file list, idles for 15 seconds, uploads a generated 1 GiB file through the application's multipart upload flow, verifies it by reading the entire remote file, idles for ten more seconds, then cleans up before quitting. It does not load or change a saved connection.

`measure.py` samples process RSS every ~100 ms and records macOS `footprint` snapshots. The upload interval includes hashing, upload, full readback verification, and refreshing the list. It is not a pure network-throughput figure. The sampler needs permission to inspect processes. The screenshot is captured by the app's native renderer.

| Measurement | Earlier S3-only native spike | Native + all rclone backends |
| --- | ---: | ---: |
| App bundle, apparent bytes | 13.9 MB | 73.6 MB |
| Disk image | 4.3 MB | 18.1 MB |
| macOS physical footprint, idle snapshot | 60.2 MB | 78.4 MB |
| macOS recorded peak physical footprint | 81.9 MB | 104.6 MB |
| Median idle RSS, latest run | 62.7 MB | 54.8 MB |
| Maximum sampled upload RSS, latest run | 97.2 MB | 88.4 MB |
| Hash/upload/full verification interval, latest run | 8.84 s | 19.96 s |

Across the three rclone runs, median idle RSS ranged from 55–81 MB and maximum sampled upload RSS from 88–127 MB. Transfer intervals ranged from 16.8–31.8 seconds. RSS and physical footprint are different measures; retain this variability when evaluating the result rather than interpreting the latest lower RSS as an improvement over the older engine. Earlier rclone samples are preserved under `results/rclone/preliminary/` and `results/rclone/before-session-fix/`.

Measurements are from the same Apple Silicon Mac, macOS 15.3.1, on 2026-10-09. MB means decimal MB; the MyGo CLI labels MiB as MB. The earlier S3-only result is a different implementation and UI scope, and machine load affects RAM/timing. These figures describe this spike, not a matched production Tauri comparison. All-provider dependencies increase disk size substantially; the 1 GiB MinIO transfer completes without buffering the entire file in RAM.

Current raw results and a native window capture are in `results/rclone/`. The previous S3-only report is preserved in `S3-ONLY.md` with its original measurements under `results/`.

## What this enables next

The engine now presents the same file operations for different storage systems. Lopload can concentrate on the desktop workflows instead of maintaining a separate S3 implementation and adding a custom engine for every provider.

The next product work is a connection library with native provider setup/sign-in, durable transfer jobs/history, restart/resume, recursive folder transfers and bulk actions, transfers between saved connections, capability-aware controls for read-only providers, production error categories, and updater/tray/distribution parity. A provider being compiled in does not mean all its features work through this UI.

Only one operation runs at a time. Upload verification incurs download bandwidth; copy and rename read both original and destination for verification. Cancellation after the server has already committed a file does not remove that file. Process termination and durable multipart resume remain untested and unimplemented in the application.

References: [rclone configuration](https://rclone.org/commands/rclone_config/), [rclone source](https://github.com/rclone/rclone), [MIT license](https://rclone.org/licence/).
