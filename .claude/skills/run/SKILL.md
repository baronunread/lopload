---
name: run
description: Run and visually test the Lopload GUI. Use whenever asked to run, screenshot, or verify UI changes in this app.
---

# Running and testing the Lopload GUI

The real app is a Tauri **WKWebView**, which Chrome DevTools cannot attach
to. Do **not** try to work around this by launching the real Tauri app and
hacking around its APIs from a browser, injecting scripts into it, or
similar — it will not work and wastes time.

## Running the app

`bun run tauri dev` — builds and launches the real desktop app (SQLite +
keychain + S3 + TransferEngine), with hot-reload on frontend changes.

`bun run dev` starts Vite alone on `http://localhost:1420`, but opening that
URL in a plain browser tab only renders a "Lopload requires the desktop app"
notice (see `src/App.tsx`, gated on `isTauriRuntime()`) — there is no
in-memory demo backend to click through anymore. Don't rely on the browser
tab for anything beyond confirming that notice renders; it does not exercise
the app's real UI.

## Verifying changes

Because Chrome DevTools can't attach to the WKWebView, there's no automated
click-through/screenshot loop against the real app from this environment.
To verify a UI change:

- Run `bun run tauri dev` and observe/interact with the window directly.
- Lean on the test suite for anything that can be expressed as a test:
  - `bun test tests/unit src` — unit tests (Rust + TS), including UI
    component tests against `tests/unit/ui/fakeServices.ts`.
  - `bun run test:integration` — integration tests against a real MinIO
    instance.

Use `bun`, never `npm`/`npx`/`node`, for any of the above.
