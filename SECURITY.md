# Security Policy

## Supported versions

Only the [latest release](https://github.com/baronunread/lopload/releases/latest) is supported. Lopload auto-updates on startup, so staying current is the default.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately via [GitHub Security Advisories](https://github.com/baronunread/lopload/security/advisories/new) ("Report a vulnerability" on the Security tab). You can expect an initial response within a week.

## What counts

Lopload's security-relevant surface:

- Credentials must live only in the OS keychain — never in SQLite, config files, logs, or error messages.
- All S3 traffic goes through the Tauri HTTP plugin (Rust); nothing should transit a third-party relay.
- Update artifacts are minisign-verified via Tauri's updater.

Anything that violates these invariants — a credential leaking into a log or the database, share links exposing more than intended, updater signature bypass — is a valid report.
