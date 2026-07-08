// Permanent in-browser demo/testing backend for the UI.
//
// This is what powers `bun run dev` when the app is opened in a normal
// browser instead of the Tauri shell (see `isTauriRuntime()` in
// src/services/real.ts and the wiring in src/App.tsx). It is a rich,
// session-scoped, in-memory fake of AppServices: a seeded connection and
// folder tree, working test-connection/save, and uploads that actually
// progress over time and emit EngineEvents — enough to exercise onboarding,
// browsing, and the transfer widget without Tauri or a real bucket.
//
// Append `?fresh` to the dev URL (e.g. http://localhost:1420/?fresh) to
// start with zero connections, for testing the onboarding flow.
import type {
  Connection,
  EngineEvent,
  RemoteEntry,
  Transfer,
  TransferState,
} from "../lib/types";
import { groupTrashObjects, isTrashKey, parseTrashKey, trashKey } from "../lib/s3/trash";
import type { AppServices, DownloadTarget, PickedFile, TrashItem } from "./services";

/** A file in the fake remote tree, keyed by full key (e.g. "photos/2024/beach.jpg"). */
interface FakeFile {
  key: string;
  size: number;
  lastModified: number;
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

function startsFresh(): boolean {
  try {
    return new URLSearchParams(location.search).has("fresh");
  } catch {
    return false;
  }
}

function seedConnections(): Map<string, Connection> {
  const map = new Map<string, Connection>();
  if (startsFresh()) return map;
  const id = "demo-connection";
  map.set(id, {
    id,
    name: "Demo storage",
    endpoint: "https://demo.example.com",
    bucket: "demo-bucket",
    lastPrefix: "",
    createdAt: now - 30 * DAY,
  });
  return map;
}

function seedFiles(): Map<string, FakeFile> {
  const files: FakeFile[] = [
    { key: "photos/sunset.jpg", size: 3_200_000, lastModified: now - 2 * DAY },
    { key: "photos/mountains.jpg", size: 4_800_000, lastModified: now - 5 * DAY },
    { key: "photos/2024/beach.jpg", size: 2_100_000, lastModified: now - 40 * DAY },
    { key: "photos/2024/hiking.jpg", size: 5_600_000, lastModified: now - 45 * DAY },
    { key: "photos/2024/family.mp4", size: 210_000_000, lastModified: now - 50 * DAY },
    { key: "documents/resume.pdf", size: 180_000, lastModified: now - 10 * DAY },
    { key: "documents/budget.xlsx", size: 92_000, lastModified: now - 12 * DAY },
    { key: "notes.txt", size: 4_096, lastModified: now - 1 * DAY },
  ];
  const map = new Map<string, FakeFile>();
  for (const f of files) map.set(f.key, f);
  return map;
}

// Module-level state — survives re-renders and remounts for the session.
const connectionsStore = seedConnections();
const filesByConnection = new Map<string, Map<string, FakeFile>>();
const transfersByConnection = new Map<string, Map<string, Transfer>>();
const listeners = new Set<(event: EngineEvent) => void>();

function filesFor(connectionId: string): Map<string, FakeFile> {
  let files = filesByConnection.get(connectionId);
  if (!files) {
    files = connectionId === "demo-connection" ? seedFiles() : new Map();
    filesByConnection.set(connectionId, files);
  }
  return files;
}

function transfersFor(connectionId: string): Map<string, Transfer> {
  let transfers = transfersByConnection.get(connectionId);
  if (!transfers) {
    transfers = new Map();
    transfersByConnection.set(connectionId, transfers);
  }
  return transfers;
}

function emit(event: EngineEvent) {
  for (const cb of listeners) cb(event);
}

function basename(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** S3-style delimiter listing: files directly under `prefix`, folders as
 * synthesized common prefixes for anything nested one level deeper. */
function listEntries(connectionId: string, prefix: string): RemoteEntry[] {
  const files = filesFor(connectionId);
  const folderKeys = new Set<string>();
  const entries: RemoteEntry[] = [];

  for (const file of files.values()) {
    if (isTrashKey(file.key)) continue;
    if (!file.key.startsWith(prefix)) continue;
    const rest = file.key.slice(prefix.length);
    if (rest === "") continue;
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      entries.push({
        kind: "file",
        name: rest,
        key: file.key,
        size: file.size,
        lastModified: file.lastModified,
      });
    } else {
      const folderName = rest.slice(0, slashIdx + 1);
      const folderKey = prefix + folderName;
      if (!folderKeys.has(folderKey)) {
        folderKeys.add(folderKey);
        // `name` is a display label, never a storage-style key — strip the
        // trailing slash so it matches the real backend (src/lib/s3/client.ts's
        // baseName()) instead of showing e.g. "photos/" in the UI.
        entries.push({ kind: "folder", name: folderName.slice(0, -1), key: folderKey });
      }
    }
  }

  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Moves everything under `fromKey` (a single file, or a folder and its
 * contents) to `toKey`, preserving relative structure. */
function moveEntries(files: Map<string, FakeFile>, fromKey: string, toKey: string) {
  if (fromKey.endsWith("/")) {
    for (const [k, f] of Array.from(files.entries())) {
      if (!k.startsWith(fromKey)) continue;
      const rest = k.slice(fromKey.length);
      const newKey = `${toKey}${rest}`;
      files.delete(k);
      files.set(newKey, { ...f, key: newKey });
    }
  } else {
    const file = files.get(fromKey);
    if (file) {
      files.delete(fromKey);
      files.set(toKey, { ...file, key: toKey });
    }
  }
}

/** Moves a file or folder into the trash location, sharing one deletedAtMs
 * across every object under a folder so the trash view can group them back
 * into a single row — mirrors moveFileToTrash/moveFolderToTrash in
 * src/lib/s3/client.ts. */
function moveToTrash(connectionId: string, key: string) {
  const files = filesFor(connectionId);
  const deletedAtMs = Date.now();
  if (key.endsWith("/")) {
    const toMove = Array.from(files.entries()).filter(([k]) => k.startsWith(key));
    for (const [k, f] of toMove) {
      files.delete(k);
      const dest = trashKey(deletedAtMs, k);
      files.set(dest, { ...f, key: dest });
    }
    // Always leave a marker for the folder itself at the trash location, even
    // if it never had one of its own — otherwise an empty (or marker-less)
    // folder wouldn't group into a single trash row.
    const markerDest = trashKey(deletedAtMs, key);
    if (!files.has(markerDest)) {
      files.set(markerDest, { key: markerDest, size: 0, lastModified: deletedAtMs });
    }
  } else {
    const file = files.get(key);
    if (!file) return;
    files.delete(key);
    const dest = trashKey(deletedAtMs, key);
    files.set(dest, { ...file, key: dest });
  }
}

const RESTORE_CONFLICT_MESSAGE =
  "Something's already there — restore skipped, the trashed copy is untouched.";

function restoreTrashItem(connectionId: string, item: TrashItem) {
  const files = filesFor(connectionId);
  const groupPrefix = trashKey(item.deletedAt, item.originalKey);
  if (item.kind === "folder") {
    const conflict = Array.from(files.keys()).some(
      (k) => !isTrashKey(k) && k.startsWith(item.originalKey),
    );
    if (conflict) throw new Error(RESTORE_CONFLICT_MESSAGE);
    const trashed = Array.from(files.entries()).filter(([k]) => k.startsWith(groupPrefix));
    for (const [k, f] of trashed) {
      const rest = k.slice(groupPrefix.length);
      const dest = item.originalKey + rest;
      files.delete(k);
      files.set(dest, { ...f, key: dest });
    }
  } else {
    if (files.has(item.originalKey)) throw new Error(RESTORE_CONFLICT_MESSAGE);
    const file = files.get(groupPrefix);
    if (!file) return;
    files.delete(groupPrefix);
    files.set(item.originalKey, { ...file, key: item.originalKey });
  }
}

function deleteTrashItemNow(connectionId: string, item: TrashItem) {
  const files = filesFor(connectionId);
  if (item.kind === "file") {
    files.delete(trashKey(item.deletedAt, item.originalKey));
    return;
  }
  const groupPrefix = trashKey(item.deletedAt, item.originalKey);
  for (const k of Array.from(files.keys())) {
    if (k.startsWith(groupPrefix)) files.delete(k);
  }
}

function emptyTrashFor(connectionId: string) {
  const files = filesFor(connectionId);
  for (const k of Array.from(files.keys())) {
    if (isTrashKey(k)) files.delete(k);
  }
}

function listTrashItems(connectionId: string): TrashItem[] {
  const files = filesFor(connectionId);
  const objects = Array.from(files.values())
    .filter((f) => isTrashKey(f.key))
    .flatMap((f) => {
      const parsed = parseTrashKey(f.key);
      return parsed
        ? [{ trashKey: f.key, originalKey: parsed.originalKey, deletedAtMs: parsed.deletedAtMs, size: f.size }]
        : [];
    });
  return groupTrashObjects(objects).map((g) => ({
    id: `${g.deletedAtMs}:${g.originalKey}`,
    originalKey: g.originalKey,
    kind: g.kind,
    deletedAt: g.deletedAtMs,
    purgeAt: g.purgeAtMs,
    size: g.totalSize,
  }));
}

const TICK_MS = 150;
const PERCENT_STEP = 18;

/** Outcome-specific cleanup hooks so cancel() can stop whichever timer
 * (the "sending" interval, or the "checking" timeout) is currently pending
 * for a transfer. */
const cancelHandles = new Map<string, () => void>();

function runTransfer(
  connectionId: string,
  transfer: Transfer,
  shouldFail: boolean,
  onSettled: (outcome: "uploaded" | "downloaded" | "failed") => void,
) {
  const transfers = transfersFor(connectionId);

  const update = (state: TransferState) => {
    const updated: Transfer = { ...transfer, state, updatedAt: Date.now() };
    transfer = updated;
    transfers.set(transfer.id, transfer);
    emit({ type: "transfer-updated", transfer });
  };

  // queued -> sending (ticking percent) -> checking -> uploaded/downloaded | failed
  update({ kind: "sending", percent: 0 });

  let percent = 0;
  const interval = setInterval(() => {
    percent = Math.min(100, percent + PERCENT_STEP);
    if (percent < 100) {
      update({ kind: "sending", percent });
      return;
    }
    clearInterval(interval);
    update({ kind: "checking" });
    const timeout = setTimeout(() => {
      cancelHandles.delete(transfer.id);
      if (shouldFail) {
        update({ kind: "failed", errorClass: "connection-dropped" });
        onSettled("failed");
        return;
      }
      if (transfer.direction === "download") {
        update({ kind: "downloaded" });
        onSettled("downloaded");
      } else {
        update({ kind: "uploaded" });
        // Like real S3, the uploaded file now exists in the remote tree.
        filesFor(connectionId).set(transfer.key, {
          key: transfer.key,
          size: transfer.size,
          lastModified: Date.now(),
        });
        onSettled("uploaded");
      }
    }, TICK_MS);
    cancelHandles.set(transfer.id, () => clearTimeout(timeout));
  }, TICK_MS);
  cancelHandles.set(transfer.id, () => clearInterval(interval));
}

// Tracks in-flight batches so we know when to emit batch-finished.
const pendingBatches = new Map<
  string,
  { total: number; settled: number; uploaded: number; downloaded: number; failed: number }
>();

function noteBatchSettlement(
  connectionId: string,
  outcome: "uploaded" | "downloaded" | "failed",
) {
  const batch = pendingBatches.get(connectionId);
  if (!batch) return;
  batch.settled += 1;
  if (outcome === "failed") batch.failed += 1;
  else if (outcome === "downloaded") batch.downloaded += 1;
  else batch.uploaded += 1;

  if (batch.settled >= batch.total) {
    pendingBatches.delete(connectionId);
    emit({
      type: "batch-finished",
      uploaded: batch.uploaded,
      downloaded: batch.downloaded,
      failed: batch.failed,
    });
  }
}

export function createDemoServices(): AppServices {
  return {
    connections: {
      async list() {
        return Array.from(connectionsStore.values());
      },
      async save(conn) {
        connectionsStore.set(conn.id, conn);
      },
      async delete(id) {
        connectionsStore.delete(id);
        filesByConnection.delete(id);
        transfersByConnection.delete(id);
      },
      async setLastPrefix(id, prefix) {
        const conn = connectionsStore.get(id);
        if (conn) connectionsStore.set(id, { ...conn, lastPrefix: prefix });
      },
    },
    browser: {
      async list(connectionId, prefix): Promise<RemoteEntry[]> {
        return listEntries(connectionId, prefix);
      },
      async createFolder(connectionId, prefix, name) {
        const files = filesFor(connectionId);
        const folderKey = `${prefix}${name}/.keep`;
        files.set(folderKey, { key: folderKey, size: 0, lastModified: Date.now() });
      },
      async rename(connectionId, key, newName) {
        const files = filesFor(connectionId);
        if (key.endsWith("/")) {
          // parent + "<old-name>/" == key, so parent is key minus name minus slash.
          const name = basename(key);
          const parent = key.slice(0, key.length - name.length - 1);
          moveEntries(files, key, `${parent}${newName}/`);
        } else {
          const parent = key.slice(0, key.length - basename(key).length);
          moveEntries(files, key, `${parent}${newName}`);
        }
      },
      async move(connectionId, key, toKey) {
        moveEntries(filesFor(connectionId), key, toKey);
      },
      async delete(connectionId, key) {
        moveToTrash(connectionId, key);
      },
      async copyLink(connectionId, key, expiresInSeconds) {
        return `https://demo.example.com/${connectionId}/${key}?sig=demo&expires=${expiresInSeconds}`;
      },
      async getThumbnailUrl() {
        return null;
      },
      async folderInfo(connectionId, key) {
        const files = filesFor(connectionId);
        let count = 0;
        let totalSize = 0;
        let lastModified: number | null = null;
        for (const f of files.values()) {
          if (isTrashKey(f.key) || !f.key.startsWith(key)) continue;
          count += 1;
          totalSize += f.size;
          if (lastModified === null || f.lastModified > lastModified) {
            lastModified = f.lastModified;
          }
        }
        return { files: count, totalSize, lastModified };
      },
      async listFilesRecursive(connectionId, prefix) {
        const files = filesFor(connectionId);
        const result: { key: string; size: number }[] = [];
        for (const f of files.values()) {
          if (isTrashKey(f.key) || !f.key.startsWith(prefix)) continue;
          if (basename(f.key) === ".keep") continue;
          result.push({ key: f.key, size: f.size });
        }
        return result;
      },
    },
    trash: {
      async list(connectionId) {
        return listTrashItems(connectionId);
      },
      async restore(connectionId, item) {
        restoreTrashItem(connectionId, item);
      },
      async deleteNow(connectionId, item) {
        deleteTrashItemNow(connectionId, item);
      },
      async emptyTrash(connectionId) {
        emptyTrashFor(connectionId);
      },
    },
    engine: {
      async listTransfers(connectionId): Promise<Transfer[]> {
        return Array.from(transfersFor(connectionId).values());
      },
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      async enqueueFiles(connectionId, prefix, files) {
        const transfers = transfersFor(connectionId);
        const created: Transfer[] = files.map((f) => ({
          id: crypto.randomUUID(),
          connectionId,
          key: `${prefix}${f.name}`,
          localPath: f.path,
          size: f.size,
          direction: "upload",
          state: { kind: "queued" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));

        for (const t of created) {
          transfers.set(t.id, t);
          emit({ type: "transfer-updated", transfer: t });
        }

        pendingBatches.set(connectionId, {
          total: created.length,
          settled: 0,
          uploaded: 0,
          downloaded: 0,
          failed: 0,
        });

        for (const t of created) {
          const shouldFail = t.key.toLowerCase().includes("fail");
          runTransfer(connectionId, t, shouldFail, (outcome) => noteBatchSettlement(connectionId, outcome));
        }
      },
      async enqueueDownloads(connectionId, targets: DownloadTarget[]) {
        const transfers = transfersFor(connectionId);
        const created: Transfer[] = targets.map((t) => ({
          id: crypto.randomUUID(),
          connectionId,
          key: t.key,
          localPath: t.localPath,
          size: t.size,
          direction: "download",
          state: { kind: "queued" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));

        for (const t of created) {
          transfers.set(t.id, t);
          emit({ type: "transfer-updated", transfer: t });
        }

        pendingBatches.set(connectionId, {
          total: created.length,
          settled: 0,
          uploaded: 0,
          downloaded: 0,
          failed: 0,
        });

        for (const t of created) {
          const shouldFail = t.key.toLowerCase().includes("fail");
          runTransfer(connectionId, t, shouldFail, (outcome) => noteBatchSettlement(connectionId, outcome));
        }
      },
      async dismiss(transferId) {
        for (const transfers of transfersByConnection.values()) {
          if (transfers.delete(transferId)) return;
        }
      },
      async cancel(transferId) {
        cancelHandles.get(transferId)?.();
        cancelHandles.delete(transferId);
        for (const [connectionId, transfers] of transfersByConnection.entries()) {
          if (!transfers.delete(transferId)) continue;
          const batch = pendingBatches.get(connectionId);
          if (batch && batch.total > 0) {
            batch.total -= 1;
            if (batch.settled >= batch.total) {
              pendingBatches.delete(connectionId);
              emit({
                type: "batch-finished",
                uploaded: batch.uploaded,
                downloaded: batch.downloaded,
                failed: batch.failed,
              });
            }
          }
          return;
        }
      },
    },
    keychain: {
      async testConnection(draft) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (draft.endpoint.toLowerCase().includes("fail")) {
          return { ok: false, message: "Couldn't reach that address." };
        }
        return { ok: true, message: "Connected." };
      },
    },
    updates: {
      async checkForUpdate() {
        return null;
      },
      async installAndRelaunch() {},
      async isAutoUpdateEnabled() {
        return true;
      },
      async setAutoUpdateEnabled() {},
    },
    settings: {
      async getDefaultDownloadDir() {
        return null;
      },
      async setDefaultDownloadDir() {},
      async getConcurrentTransfers() {
        return 3;
      },
      async setConcurrentTransfers() {},
    },
    async pickFiles(): Promise<PickedFile[]> {
      return [
        { path: "/demo/vacation.mp4", name: "vacation.mp4", size: 220_000_000 },
        { path: "/demo/notes.txt", name: "notes.txt", size: 4_096 },
        { path: "/demo/cover.png", name: "cover.png", size: 1_800_000 },
      ];
    },
    async pickSaveDestination(defaultName) {
      return `/demo/downloads/${defaultName}`;
    },
    async pickDownloadDirectory() {
      return "/demo/downloads";
    },
    async openFile(connectionId, key, name) {
      console.debug("[demo] openFile", connectionId, key, name);
    },
    onFileDrop() {
      return () => {};
    },
    setBadgeCount(count) {
      console.debug("[demo] setBadgeCount", count);
    },
    notify(title, body) {
      console.debug("[demo] notify", title, body);
    },
  };
}
