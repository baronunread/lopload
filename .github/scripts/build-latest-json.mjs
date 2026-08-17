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
  const encoded = readFileSync(sigPath, "utf8").trim();
  const signature = Buffer.from(encoded, "base64").toString("utf8").trim();
  if (!signature.startsWith("untrusted comment:") || !signature.includes("trusted comment:")) {
    throw new Error(`Invalid Minisign signature in ${sigPath}`);
  }
  return {
    path: match,
    signature,
  };
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

const macArchive = files.find((file) => file.endsWith(".app.zip"));
const darwinArch = macArchive?.includes("darwin-aarch64") ? "aarch64" : "x86_64";
const wanted = [
  { key: `darwin-${darwinArch}`, suffix: ".app.zip" },
  { key: "linux-x86_64", suffix: ".AppImage" },
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
    "Every downloaded bundle-* artifact must contain a signed updater package — check the signing secret and all three build jobs.",
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
