import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// The self-test (`bun run selftest`) launches a second Tauri dev server, and
// would collide with a `bun run tauri dev` you already have open — strictPort
// makes that a hard failure. So it runs on its own port, passed through here
// and matched by a devUrl override in scripts/selftest.ts. Normal dev is
// unaffected and stays on 14320.
// @ts-expect-error process is a nodejs global
const port = Number(process.env.LOPLOAD_VITE_PORT ?? 14320);

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@aws-sdk/")) return "aws-sdk";
          if (id.includes("motion")) return "motion";
          if (id.includes("hash-wasm")) return "hash-wasm";
          if (id.includes("@phosphor-icons")) return "icons";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("@cloudflare/kumo")) return "kumo";
          if (id.includes("react-dom") || id.includes("react/")) return "react";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
}));
