---
name: release-docs
description: Update AGENTS.md, README.md, CHANGELOG.md, and the lopload-docs site from the commits in the latest release (between the newest tag and the one before it). Use when cutting a release or when asked to "update docs for the release" / "write the changelog for the new tag".
---

# Update docs for the latest release

Goal: read every commit in the newest release (the range between the two most
recent tags) and fold whatever they changed into the four documentation
surfaces below. Be conservative — only touch a doc when a commit actually
changes something that doc describes. When in doubt, leave prose alone and
just record the change in the changelog.

## 1. Find the release range

Tags are semver `vX.Y.Z`. The newest tag is the release you're documenting;
the one before it is the baseline.

```sh
git fetch --tags --quiet
LATEST=$(git tag --sort=-v:refname | sed -n 1p)
PREV=$(git tag --sort=-v:refname | sed -n 2p)
echo "Documenting $PREV..$LATEST"
```

Edge cases:
- **Only one tag exists** (`PREV` empty): use the repo root as the baseline —
  `PREV=$(git rev-list --max-parents=0 HEAD | tail -1)`.
- **Unreleased work** (commits after `$LATEST` you also want to capture):
  ask the user whether to document `$LATEST` or `$LATEST..HEAD` before
  proceeding. Default to the tag-to-tag range.

## 2. Read the commits

Get the full range with bodies, and a file-level view so you can tell what
each commit actually touched:

```sh
git log --no-merges --no-decorate "$PREV..$LATEST" \
  --pretty=format:'%n=== %h %s ===%n%b'
git log --no-merges --stat --oneline "$PREV..$LATEST"
```

Read the actual diffs for anything ambiguous (`git show <hash>`). Sort the
changes in your head into buckets:

- **User-facing** (features, UX, fixes a user would notice) → CHANGELOG,
  README features, lopload-docs guides.
- **Security / behavioral** (auto-update, credential handling, verification)
  → CHANGELOG, lopload-docs reference pages, SECURITY.md if the model changed.
- **Developer-facing** (architecture, commands, directory layout, build,
  dependencies) → AGENTS.md only.
- **Internal churn** (refactors, test-only, chore) → usually document nothing,
  or a single terse changelog line if it's notable.

Ignore version-bump / release-plumbing commits — they aren't release notes.

## 3. Update the four surfaces

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

- Version = `$LATEST` without the `v`.
- Date = the tag date: `git log -1 --format=%as "$LATEST"`.
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

## 4. Report

End with a compact summary:
- The range documented (`$PREV..$LATEST`) and commit count.
- Per file: what changed, or "unchanged (no relevant commits)".
- Anything you deliberately skipped and why.
- A reminder that lopload-docs changes are in a separate repo and need their
  own commit.

Do not commit anything unless the user asks.
