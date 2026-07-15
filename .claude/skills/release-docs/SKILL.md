---
name: release-docs
description: Cut a release: bump version, update docs, tag, and push. Invoke with /release-docs vX.Y.Z.
---

# Cut a release

Usage: `/release-docs vX.Y.Z`

The version must be a semver bump after the latest tag. The workflow:

1. Validate the version is the next one after the latest tag.
2. Confirm with the user.
3. Run `bun run set-version <version>`.
4. Read every commit between the latest tag and HEAD.
5. Update CHANGELOG.md, README.md, AGENTS.md, and lopload-docs.
6. Commit the docs changes.
7. Run `bun run check` (typecheck + tests) — abort on failure.
8. Tag and push.

## 1. Validate the version

```sh
git fetch --tags --quiet
LATEST_TAG=$(git tag --sort=-v:refname | sed -n 1p)
```

The argument (e.g. `v0.1.3`) must be a valid semver tag that sorts after
`$LATEST_TAG`. Compare with `git tag --sort=-v:refname` to confirm.

If the argument is not the immediate next version, surface the full tag list
and ask the user to confirm anyway. Accept `--force`-like override only with
explicit user consent.

## 2. Confirm with the user

Show the plan:

```
Release: <version>
Range:   <LATEST_TAG>..HEAD
Commits: <count>
```

Ask "Ready to cut this release?" before proceeding.

## 3. Bump the version

```sh
bun run set-version <version-without-v>
```

This updates `package.json` (source of truth), `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`.

## 4. Read the commits

```sh
git log --no-merges --no-decorate "$LATEST_TAG..HEAD" \
  --pretty=format:'%n=== %h %s ===%n%b'
git log --no-merges --stat --oneline "$LATEST_TAG..HEAD"
```

Read the actual diffs for anything ambiguous (`git show <hash>`). Sort the
changes into buckets:

- **User-facing** (features, UX, fixes a user would notice) → CHANGELOG,
  README features, lopload-docs guides.
- **Security / behavioral** (auto-update, credential handling, verification)
  → CHANGELOG, lopload-docs reference pages, SECURITY.md if the model changed.
- **Developer-facing** (architecture, commands, directory layout, build,
  dependencies) → AGENTS.md only.
- **Internal churn** (refactors, test-only, chore) → usually document nothing,
  or a single terse changelog line if it's notable.

Ignore version-bump / release-plumbing commits — they aren't release notes.

## 5. Update the four surfaces

Work in this order. After each file, note what you changed for the final
summary.

### CHANGELOG.md — `/Users/andreabruno/Products/lopload/CHANGELOG.md`

Add a new section directly under the intro paragraph, above the previous
release. Match the existing format exactly:

```
## [X.Y.Z] — YYYY-MM-DD

<one-line release theme, optional>

- Bullet per user-facing change, present-tense, user's-eye view
```

- Version = the argument without the `v`.
- Date = today's date (the release date).
- Group logically (added / changed / fixed) only if the release is large;
  otherwise a flat bullet list like the `0.1.0` entry is preferred.
- Write for users, not committers — "Presigned share links now expire by
  default", not "refactor share.ts".

### README.md — `/Users/andreabruno/Products/lopload/README.md`

Only edit if the release changed something the README states: the one-line
pitch, the Quick Start commands, or the Features list. Do **not** add a
changelog here or bump badges (they're dynamic). Leave it untouched if the
release was internal.

### AGENTS.md — `/Users/andreabruno/Products/lopload/AGENTS.md`

The developer/agent guide. Update only the sections a commit invalidated:
Quick start commands, the credential-backend table, Architectural decisions,
Directory layout, or dependency/toolchain notes. Keep its terse, factual
voice. Never add release notes here — this file describes how the code works
*now*, not what changed.

### lopload-docs — `/Users/andreabruno/Products/lopload-docs/` (separate repo)

Public docs, an Astro Starlight site. Content lives in
`src/content/docs/`:
- `guides/` — getting-started, installation, share-links, transfers, trash
- `reference/` — auto-updates, security, troubleshooting

Update the specific page(s) a user-facing change affects. If a release adds a
whole new capability with no matching page, ask the user whether to add one
rather than inventing structure. This is a **different git repo** — do not
stage or commit it together with lopload; leave its changes in the working
tree and mention them in the summary.

## 6. Commit the docs

```sh
git add CHANGELOG.md README.md AGENTS.md package.json src-tauri/
git commit -m "chore: release <version>"
```

If README.md or AGENTS.md are unchanged, omit them from the add.

## 7. Verify

```sh
bun run check
```

If it fails, report the failure and stop — do not tag.

## 8. Tag and push

```sh
git tag -a <version> -m "<version>"
git push origin <version>
git push origin main
```
