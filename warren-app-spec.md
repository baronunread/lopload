# Warren — spec

A desktop file manager for S3-compatible storage. You add credentials for
one or more buckets, then drag files into it like any other file manager.
Windows, macOS, and Linux. Nothing in the interface should ever say
"bucket," "object," or "key" — to the person using it, these are just
folders and files.

(Named Warren: a warren is several burrows under one roof — fits a
multi-bucket switcher better than "profile" ever did.)

## The problem this exists to solve

Cloud upload tools routinely fail in ways that are ambiguous rather than
obvious: a transfer silently stalls, or the app reports success when only
part of a file actually landed. If the interface can't be trusted to show,
unmistakably, whether a transfer really succeeded, people will eventually
make a costly assumption in the wrong direction — for example, deleting a
local copy before confirming the remote one is intact.

Every design and engineering decision below exists to make that specific
failure mode impossible: status must always be explicit, verified, and
sticky until acknowledged, never implied or assumed.

## Design principles

Soft, calm, uncluttered — a tool people trust precisely because it doesn't
try to look impressive. Clarity beats personality everywhere status is
communicated; personality is fine everywhere else.

**Component library: Kumo** (`@cloudflare/kumo`, React + Tailwind, built on
Base UI). It's accessible by default and already ships the primitives this
app leans on hardest — `Toast` for status events, `Meter` for transfer
progress, `Dialog` for confirmations, `Table` for file listings, `Empty`
for empty-state folders, `Loader` for in-flight states — so most of the UI
is composition, not custom-built widgets.

**Theming**: override Kumo's semantic color tokens with a soft, pastel
palette rather than building components from scratch. Starting point:
- Background `#F7F8FA`, surface `#FFFFFF`
- Primary accent `#A9C9F5`, hover `#8FB6EE`
- Success `#BFE8CE` / text-on-success `#1F5C36`
- In-progress `#FCE3A0` / text `#7A5A0C`
- Danger `#F5C3C0` / text-on-danger `#8A2E28`
- Text primary `#31353D`, text secondary `#6C717C`

Typography: one rounded, friendly sans for headings (Nunito or Quicksand),
paired with Inter for file names/sizes where small-size legibility matters
more than personality.

**Motion**: gentle and purposeful only — a progress fill, a soft settle on
completion. No spinners with no context, no bouncing.

## Core UX requirements

### Status must always be explicit, never implied

Every file in the transfer list shows one of exactly these states, as a
labeled chip via Kumo's `Badge`/`Toast` (never just a color with no label):

| State | Meaning | Visual |
|---|---|---|
| Queued | waiting to start | neutral chip |
| Sending — 42% | actively uploading | amber chip, live percentage via `Meter` |
| Checking | transfer finished, verifying integrity | amber chip, pulsing |
| Uploaded ✓ | verified against the server | mint chip |
| Couldn't send — tap to retry | failed | coral chip, always sticky, never auto-dismisses |

"Uploaded ✓" is deliberately the only state that reads as calm and
finished. Every other state should read as visibly unfinished, so nothing
is ever ambiguous at a glance.

### Verification, not just "the request returned 200"

After the last byte is sent, do a follow-up integrity check — compare a
local hash against the server's returned ETag, or re-fetch metadata and
compare size — before flipping to "Uploaded ✓". A network hiccup that
truncates a transfer but still returns success from the SDK must not be
able to produce a false "done."

### Failures are loud and specific, in plain language

No raw SDK/XML errors. Translate known failure classes ("no internet,"
"storage full," "credentials rejected," "connection dropped mid-transfer")
into one plain sentence plus a single retry button, via Kumo's `Toast` and
`Banner`. A failed file stays visibly failed — in the list, in the
window/dock badge, and as a native OS notification — until acknowledged.

### Resumable, not just retryable

Large uploads use multipart upload with part ETags and the upload ID
persisted locally (not just in memory), so an app or machine restart
resumes from the last completed part instead of starting over or silently
giving up.

**Orphaned uploads clean themselves up, invisibly.** This is different
from the failed-transfer behavior above, and the distinction matters: a
transfer that's actively failed and retryable stays loudly, visibly failed
until acknowledged — that doesn't change. But a multipart session that's
been abandoned entirely (its local tracking record is gone — app
reinstalled, history cleared, whatever — while an incomplete upload
session is still sitting open on the server racking up storage cost) isn't
something the person using the app was ever looking at. On a schedule (a
few days' age is reasonable), Warren lists open multipart uploads via S3's
`ListMultipartUploads` and aborts anything with no matching local record.
No toast, no badge, no trace in the UI — the same way you'd never notice a
temp file getting swept. Surfacing this as an event would recreate exactly
the "wait, did something go wrong?" confusion this whole app exists to
avoid, for something that was never actionable in the first place.

### It should feel like a file manager, not a cloud console

- Drag-and-drop from the OS, recursive folder drag-and-drop, a native file
  picker.
- Breadcrumb folder navigation on the remote side.
- No storage-world terminology in the UI — "folder" and "file," never
  "prefix," "bucket," or "object."
- Right-click context menu: rename, delete, new folder, copy link.
- Deleting is supported, same as any file manager — but this app
  intentionally stops at ordinary delete. It has none of the scheduling,
  staged retention, or bulk-review workflow that the companion Dock app
  provides; if that level of control over what gets removed and when
  matters, that belongs on the Dock side, not here.

### Multiple buckets, one simple switcher

- A bucket switcher (Kumo `Dropdown` or `Select` in the header) lists
  saved bucket connections by a short name you assign, e.g. "Videos" /
  "Documents" / "Client X."
- Each entry stores its own endpoint, access key, secret key, bucket, and
  optional region, independently, in the OS keychain.
- Switching buckets swaps the entire browser view — folder tree, transfer
  history — no mixing state between them.
- Each bucket remembers the last folder you were browsing in it, so
  switching back to a bucket you've used before returns you there rather
  than resetting to root every time.
- Adding a bucket reuses the same one-screen setup flow as first run (see
  below), just invoked from "Add storage" in the switcher.

### Runs unattended, reports back when done

- Transfers continue in the background if the window is minimized; a
  system tray/menu-bar icon shows overall progress.
- Native OS notification on completion ("3 files uploaded" / "1 file
  failed, tap to retry").

### Setup is one screen per bucket

- Fields: endpoint URL, access key, secret key, bucket, optional region.
- A "Test connection" button performs a small write + delete before
  allowing save, with a plain-language result either way.
- Credentials live in the OS keychain, never a plaintext config file.

## Feature list

**MVP**
- Multi-bucket support with a header switcher, remembering last folder per bucket
- Drag-and-drop + picker upload, folders and files
- Multipart upload with resumable state
- Silent cleanup of orphaned multipart sessions
- Post-upload integrity verification
- Explicit per-file status chips as above
- Native notifications on completion/failure
- Remote folder browsing/navigation, breadcrumbs
- New folder, rename, delete, right-click menu
- One-screen credential setup per bucket with test-connection
- Secure credential storage (OS keychain), scoped per bucket
- Thumbnail previews for video/image files

**Nice to have, not blocking**
- Transfer speed graph / ETA
- Bandwidth throttle slider
- Auto-launch at login, always-on tray icon
- Persistent "recently uploaded" history view per bucket
- Light/dark mode following the OS (Kumo's tokens support this natively)

## Suggested tech stack

- **Shell**: Tauri v2 (Rust) — small installable binaries for Windows
  (.msi/.exe), macOS (.dmg, both Intel and Apple Silicon), and Linux
  (.AppImage/.deb), with native file dialogs, drag-and-drop, tray, and
  notifications via plugins.
- **Frontend**: React, specifically to use Kumo — this is the deciding
  factor in choosing React over Svelte/vanilla here.
- **Component library**: `@cloudflare/kumo` (see Design principles above)
- **S3 client**: `@aws-sdk/client-s3` for manual multipart control
  (`createMultipartUpload` / `uploadPart` / `completeMultipartUpload`) —
  resumability requires tracking part ETags yourself, which
  `@aws-sdk/lib-storage`'s automatic `Upload` helper doesn't persist
  across process restarts.
- **Tauri plugins**: `tauri-plugin-store` (per-bucket transfer history/
  state), `tauri-plugin-notification`, `tauri-plugin-fs`,
  `tauri-plugin-dialog`, a keychain plugin for credentials,
  `tauri-plugin-updater` for shipping fixes without manual reinstalls.
- **Local state**: SQLite via `tauri-plugin-sql`, one row per bucket per
  tracked transfer, plus one row per bucket recording its last-browsed
  folder.
