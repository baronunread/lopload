---
name: verify
description: Verify Lopload changes by driving the real app through the Host-seam scenario runners. Use whenever asked to run, test, or verify app behavior or UI changes.
---

# Verifying Lopload changes

The app's automation surface is the **Host seam**, not a browser: the real
Tauri window is a WKWebView that Chrome DevTools cannot attach to, so there
is no click-through/screenshot loop against it. Don't try to inject scripts
into the real window or drive it from a browser — the scenario runners below
ARE the automation.

## The two runners, one scenario list

Scenarios live in `tests/scenarios/` (registered in `tests/scenarios/index.ts`)
and run in both places:

- **Runner A — inner loop:** `bun test tests/app.test.ts`
  Mounts the real `AppShell` + real `AppServices` on a Node host
  (`tests/support/nodeHost.ts`), against a real MinIO (docker container is
  started automatically; `bun run minio:stop` removes it). Fast; run on every
  save. `bun run test` includes it along with the unit tests.

- **Runner B — the real app:** `bun run selftest`
  Launches the actual Tauri binary (`bunx tauri dev` on port 14330, so it
  coexists with a `bun run tauri dev` you already have open) and runs the same
  scenarios inside its webview: real Rust IPC (`http_send`, `write_at`), real
  OS keychain, real SQLite, real disk, real MinIO. Its SQLite db and settings
  file are selftest-scoped (`lopload-selftest.db` / `settings-selftest.json`),
  so wiping state between scenarios never touches the connections the real
  app has saved. Exit code comes from the
  `SELFTEST_RESULT PASS|FAIL` sentinel. Budget ~10 min cold (cargo build),
  ~1–2 min warm. Linux needs a running Secret Service provider
  (gnome-keyring / KWallet).

- **Against a real provider (R2):** `bun run test:remote` — Runner A pointed
  at the bucket in `.env.remote`; the suite is a guest there, scoped under
  `lopload-test/<run-id>/`. Use when the bug is provider-specific (R2 has
  bitten before where MinIO passed: checksums, signatures).

## Verifying a change

1. Express the behavior as a scenario (or extend one): seed the bucket in
   `arrange()` — the app lists once on mount and never polls, so objects
   written during `run()` can lose the race — then act with `ctx.user`
   (real userEvent), script native dialogs with `ctx.control`, and assert
   with `ctx.expect` / `ctx.waitFor` and `ctx.bucket` (what really landed).
2. `bun test tests/app.test.ts` until green.
3. `bun run selftest` to prove it in the real binary — this is what replaces
   "test it by hand against a real bucket" (needs OS keychain; skip on headless Linux without Secret Service).

Fault injection (network errors, S3 error codes) goes through the scenario's
`wrapFetch` + `nodeOnly: true` — the Node runner owns fetch; the in-app
runner skips those scenarios.

## Gotchas

- `bun`/`bunx` for everything; never npm/npx/node.
- Never import `bun:test` inside `tests/scenarios/` — assertions come from
  `ctx.expect` so the same file runs in the webview.
- Nothing reachable from `src/selftest/mount.tsx` may import node-only
  modules (docker/`node:fs` helpers live in `tests/support/storage.ts` /
  `nodeHost.ts`; type-only imports from them are fine).
- `bun run tauri dev` launches the app for human eyeballing (hot-reload on
  frontend changes); `bun run dev` alone only renders a "requires the
  desktop app" notice in a browser.
- App logs: `~/Library/Logs/com.lopload/` (JSON lines; 4xx S3 responses log
  at WARN with method+URL).
