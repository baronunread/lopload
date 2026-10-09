# Lopload native MyGo spike

A real, standalone native file browser on MyGo **v0.3.7**, on branch `spike/mygo`. It uses Go widgets drawn by MyGo, without React, JavaScript, or a webview. The production Tauri app is unchanged.

Implemented: keychain-backed connection, hierarchical storage listing, virtualized file list with keyboard selection, search, native file picker, streaming single-request upload, throttled progress, cancellation, and local MD5 verification against the upload response and a subsequent remote stat. The storage implementation is MinIO's Go S3 client, not rclone; additional providers have not been evaluated in this continuation.

## Run

From this directory, with Go 1.27.2 or newer:

```sh
go tool mygo dev
go tool mygo build
```

The build uses the existing local `Lopload Dev` signing identity. Use `go tool mygo build -sign -` for ad hoc signing on another machine. This is a locally signed development app, not notarized or ready for public distribution.

The connection screen stores credentials in the OS keychain under `lopload-native-spike`, independently of production Lopload. It defaults to the local MinIO address; enter your storage name and credentials. Double-click a folder or select it and press Enter to browse. `Up` returns to the parent.

## Tests

Start the repository's persistent test MinIO on port 9400. From the repository root, `bun test` starts it if needed; Docker must be running. Then:

```sh
cd spike-mygo-native
go test -race -v ./...
```

The tests use real MinIO and the real OS keychain. Every test owns a fresh storage container and deletes only its own files. The keychain test uses a disposable dummy connection at this spike's service name; it replaces and removes the spike's saved connection, never production credentials.

Assertions cover stored bytes read back with a separate S3 client, checksum verification, progress, cancellation before and during upload, folder listings, the same native view displaying real storage results, search, and keyboard selection in a 10,000-row virtualized list. No storage or engine doubles.

Cross-compilation checked successfully, without cgo:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/lopload-native-linux .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o /tmp/lopload-native-windows.exe .
```

## Reproduce the loaded-app benchmark

```sh
go tool mygo build
python3 measure.py build/darwin-arm64/spike-mygo-native.app/Contents/MacOS/spike-mygo-native /tmp/lopload-native-results
```

`--benchmark` is an explicit test mode. It connects only to MinIO at `127.0.0.1:9400` with the repository's local test credentials, creates a unique temporary storage container with 1,000 real empty files, opens their native list, idles for 15 seconds, uploads a generated 1 GiB file through the application's upload flow, reads the entire remote file back, idles for ten more seconds, and deletes its fixtures. It never loads or writes a saved connection. The app captures its rendered window to the OS temporary directory as `lopload-native-window.png`.

`measure.py` samples process RSS every ~100 ms with `ps`, and also records macOS `footprint` snapshots. The reported upload interval includes local hashing, sending, stat/list verification, and full remote readback; it is not a pure network throughput measurement. The sampler requires permission to inspect processes. Do not interrupt the benchmark if you want its cleanup to finish.

## Measurements

Measured on this Apple Silicon Mac on 2026-10-09, release build, locally signed. MB below means decimal MB.

| Measurement | Result |
| --- | ---: |
| App bundle, apparent bytes | 13.9 MB |
| Disk image | 4.3 MB |
| Median idle RSS with 1,000 real files | 62.7 MB |
| Maximum sampled RSS during 1 GiB transfer/readback | 97.2 MB |
| macOS physical footprint at idle snapshot | 60.2 MB |
| macOS recorded peak physical footprint | 81.9 MB |
| 1 GiB hash/upload/verification/readback interval | 8.84 s |

Bundle sizes above use actual apparent bytes (the MyGo CLI labels MiB as MB). RSS and physical footprint measure different things, so their peaks need not match.

Raw measurements are in `results/`, and a capture of the real rendered native window is `results/native-window.png`. The full Tauri app was **not remeasured** in this continuation. Earlier Claude numbers used Activity Monitor, different UI states, and a full application; do not subtract them from RSS measurements or treat this as feature parity.

The first loaded benchmark exposed a whole-file SDK buffer: `SendContentMd5` on our non-seekable progress wrapper allocated approximately 1 GiB. Removing that redundant SDK calculation, while retaining our own MD5 and remote verification, reduced sampled upload peak RSS from 1,121 MB to 95–97 MB across two corrected runs. The failed design's raw RSS data is retained in `results/buffered-before-fix.json`. The corrected version streams signed requests without loading the file into memory.

## Decision and remaining work

MyGo native UI is viable enough to continue evaluating: the actual file list renders, keyboard/search behavior is tested, a large upload completes with bounded memory, and macOS packaging works. These measurements supersede the earlier 25 MB hello-world figure for this larger spike. They do not establish a production migration recommendation.

Still missing: multipart uploads and durable resume, download/delete/rename/copy actions, SQLite-backed transfer state, multiple connections, updater/tray parity, production error categories, and additional providers. Files above 5 GiB are rejected. Cancellation cannot guarantee an upload that the server has already committed will disappear.

The existing `go-keyring` dependency is retained. Its macOS backend invokes Apple's security CLI; app-specific keychain access control remains unresolved. No plaintext credential storage was introduced.

Linux and Windows were compiled, not launched. The real native macOS window was inspected and captured; the file picker and complete manual connection/upload click-through have not been driven. Screen reader behavior, drag and drop, interrupted uploads after process restart, and signing/notarization for distribution remain untested.
