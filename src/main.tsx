import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
// Self-hosted font files backing the --font-heading/--font-body stacks in
// ui/theme.css (per warren-app-spec.md's Nunito/Inter typography pairing).
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "./ui/theme.css";
import "./ui/noise.css";
import App from "./App";

// Runner B (`bun run selftest`, see src/selftest/mount.tsx) runs the same
// tests/scenarios/* list as `bun test` inside this real webview instead of
// rendering the app normally. The `if` has to stay written exactly like this
// — a static check on a VITE_-prefixed env var — so that when
// VITE_LOPLOAD_SELFTEST isn't set at build time (i.e. every normal `bun run
// build`), Vite inlines it as `undefined` and Rollup's dead-code elimination
// drops both this branch and the dynamic import, keeping the self-test
// module (and its @testing-library/react, tests/scenarios/* dependency
// graph) out of the shipped bundle entirely.
if (import.meta.env.VITE_LOPLOAD_SELFTEST) {
  void import("./selftest/mount");
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
