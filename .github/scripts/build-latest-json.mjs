// Builds the tauri-plugin-updater static manifest (latest.json) for a
// GitHub release. Runs after `actions/download-artifact` has merged every
// platform's `src-tauri/target/release/bundle/` into the current directory.
//
// We don't use tauri-apps/tauri-action (which does this automatically) — the
// existing release workflow builds and uploads bundles by hand, so this
// mirrors the same recipe by hand: read the `.sig` file the CLI wrote next
// to each updater-eligible bundle and pair it with the asset's eventual
// GitHub Release download URL.
//
// Schema: https://v2.tauri.app/plugin/updater/#static-json-file
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(".");

function findSigned(suffix) {
  const match = files.find((f) => f.endsWith(suffix));
  if (!match) return null;
  const sigPath = `${match}.sig`;
  if (!files.includes(sigPath)) return null;
  return { path: match, signature: readFileSync(sigPath, "utf8").trim() };
}

function readMarker(name, fallback) {
  const match = files.find((f) => f.endsWith(name));
  if (!match) return fallback;
  return readFileSync(match, "utf8").trim();
}

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
if (!repo || !tag) {
  throw new Error("GITHUB_REPOSITORY and GITHUB_REF_NAME must be set");
}
const version = tag.replace(/^v/, "");

function assetUrl(path) {
  return `https://github.com/${repo}/releases/download/${tag}/${path.split("/").pop()}`;
}

const darwinArch = readMarker("updater-arch-darwin.txt", "x86_64");

// One entry per platform tauri-plugin-updater checks against at runtime.
// Suffixes follow createUpdaterArtifacts: true (Tauri v2 native): the updater
// consumes the bundles themselves (.AppImage, NSIS -setup.exe) plus a .sig
// sidecar — only macOS still wraps in .app.tar.gz. The .AppImage.tar.gz /
// .nsis.zip names belong to the "v1Compatible" mode we don't use.
const wanted = [
  { key: `darwin-${darwinArch}`, suffix: ".app.tar.gz" },
  { key: "linux-x86_64", suffix: ".AppImage" },
  // Windows produces both an NSIS and an MSI installer; NSIS is the one
  // tauri-plugin-updater expects on this platform.
  { key: "windows-x86_64", suffix: "-setup.exe" },
];

const platforms = {};
const missing = [];

for (const { key, suffix } of wanted) {
  const found = findSigned(suffix);
  if (!found) {
    missing.push(`${key} (looked for a signed *${suffix})`);
    continue;
  }
  platforms[key] = { signature: found.signature, url: assetUrl(found.path) };
}

if (missing.length > 0) {
  console.error("Missing signed updater artifacts for:\n" + missing.map((m) => `  - ${m}`).join("\n"));
  console.error(
    "Every downloaded bundle-* artifact must contain a signed updater bundle — check that " +
      "TAURI_SIGNING_PRIVATE_KEY was set for this run and that all three build jobs succeeded.",
  );
  process.exit(1);
}

const manifest = {
  version,
  notes: `See the release notes on GitHub: https://github.com/${repo}/releases/tag/${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2));
console.log(`Wrote latest.json for ${version}:`, Object.keys(platforms));
