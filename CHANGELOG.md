# Changelog

All notable changes to Lopload are documented here. Release binaries and full notes live on the [releases page](https://github.com/baronunread/lopload/releases).

## [0.1.0] — unreleased

Initial public release.

- Multi-connection file manager for S3-compatible storage (R2, S3, B2, MinIO, …)
- Verified uploads: local MD5 checked against the server ETag after every transfer
- Sticky failures — failed transfers stay visible until acted on
- Recoverable trash instead of immediate deletes
- Presigned share links with configurable expiry
- Drag-and-drop uploads and moves
- Credentials stored only in the native OS keychain
- Signed auto-updates via GitHub Releases
