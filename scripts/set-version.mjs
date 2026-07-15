// Sets the app version. package.json is the single source of truth: the macOS
// About panel + updater read it because src-tauri/tauri.conf.json is set to
// "version": "../package.json", so that file isn't touched here. The Rust
// crate (Cargo.toml + Cargo.lock) is kept in lockstep so CARGO_PKG_VERSION
// never drifts from the app version.
//
// Run locally with an explicit version:
//
//   bun run set-version 0.1.2
//
// or with no argument in CI, where it reads the version from the pushed git
// tag (GITHUB_REF_NAME, e.g. v0.1.2 -> 0.1.2). Fails loudly on a non-semver
// version, or if any target file's version field can't be found, rather than
// silently leaving a file behind at the old number.
import { readFileSync, rmSync, writeFileSync } from "node:fs";

function resolveVersion() {
  const arg = process.argv[2];
  if (arg) return arg.replace(/^v/, "");
  const tag = process.env.GITHUB_REF_NAME;
  if (tag) return tag.replace(/^v/, "");
  throw new Error(
    "Pass a version (e.g. `bun run set-version 0.1.2`) or set GITHUB_REF_NAME (CI tag builds)",
  );
}

const version = resolveVersion();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`"${version}" is not a semver version`);
}

// Each target pairs a file with a regex whose first capture group is
// everything up to the version literal, so `$1"<version>"` rewrites only that
// one value and leaves the rest of the file's formatting untouched.
const targets = [
  { path: "package.json", re: /("version":\s*)"[^"]*"/ },
  // Anchored to the [package] table so dependency versions further down the
  // manifest are never touched.
  { path: "src-tauri/Cargo.toml", re: /(\[package\][\s\S]*?\nversion = )"[^"]*"/ },
  // The workspace's own entry in the lockfile, matched by package name so the
  // hundreds of dependency entries are left alone.
  { path: "src-tauri/Cargo.lock", re: /(name = "lopload"\nversion = )"[^"]*"/ },
];

for (const { path, re } of targets) {
  const before = readFileSync(path, "utf8");
  if (!re.test(before)) {
    throw new Error(`Could not find a version field to patch in ${path}`);
  }
  writeFileSync(path, before.replace(re, `$1"${version}"`));
}

// `tauri dev` re-signs and re-copies the binary each run but won't rewrite an
// existing Contents/Info.plist, so on macOS a version bump keeps showing the
// old build number in the About panel until this stale dev bundle is cleared.
// Removing it forces the next `tauri dev` to regenerate the plist. force:true
// makes it a no-op when the bundle isn't there (fresh checkout, CI, Windows).
rmSync("src-tauri/target/debug/Contents", { recursive: true, force: true });

console.log(`Set version to ${version} in:\n  ${targets.map((t) => t.path).join("\n  ")}`);
