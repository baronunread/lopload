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
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
