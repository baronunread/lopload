---
name: run
description: Run and visually test the Lopload GUI. Use whenever asked to run, screenshot, or verify UI changes in this app.
---

# Running and testing the Lopload GUI

The real app is a Tauri **WKWebView**, which Chrome DevTools cannot attach
to. Do **not** try to work around this by launching the real Tauri app and
hacking around its APIs from a browser, injecting scripts into it, or
similar — it will not work and wastes time.

## The canonical loop

1. `bun run dev` — starts Vite on `http://localhost:1420`.
2. Open that URL in a normal browser (or drive it via the Chrome DevTools
   MCP tools / skills).

Outside of Tauri, the app automatically falls back to a rich in-memory demo
backend instead of the real engine/keychain/S3 stack. The decision point is
`isTauriRuntime()`, checked in `src/App.tsx`; the fake implementation lives
in `src/ui/demoServices.ts`.

The demo backend gives you a fully working app to click through:

- A seeded connection ("Demo storage") with a seeded folder tree
  (`photos/`, `photos/2024/`, `documents/`, plus some top-level files) —
  browsing, rename, delete, create-folder, and copy-link all work against
  this in-memory tree.
- "Test connection" resolves after ~600ms. An endpoint containing the word
  `fail` (e.g. `https://fail.example.com`) makes it fail with a plain-language
  error; anything else succeeds.
- Uploads (via the file picker or drag-drop) actually run: transfers move
  queued → sending (with ticking progress) → checking → uploaded, emitting
  real `EngineEvent`s the whole way, so the transfer widget/UI updates live.
  A picked/dropped file whose name contains `fail` ends as a failed transfer
  instead.
- `http://localhost:1420/?fresh` starts the session with **zero**
  connections, so you can exercise the onboarding/setup flow from scratch.
  Without `?fresh`, the seeded connection is present so you land straight in
  the browsing view.

State is session-scoped module state — it resets on a full page reload but
survives React re-renders, so you can navigate around and come back.

## What this does NOT cover

Rust-side behavior — the real keychain integration and real S3/MinIO
calls — is not exercised by the browser demo at all. For that, use:

- `bun test tests/unit src` — unit tests (Rust + TS).
- `bun run test:integration` — integration tests against a real MinIO
  instance.

Use `bun`, never `npm`/`npx`/`node`, for any of the above.
