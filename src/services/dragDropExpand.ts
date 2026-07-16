// Pure logic for expanding OS drag-and-drop paths (which may include
// directories) into a flat list of files, preserving each file's path
// relative to the dropped directory as a "/"-joined prefix on `name` — so
// the remote key built from `prefix + name` in the engine keeps the folder
// structure intact. No Tauri/file-system imports here: I/O is injected via
// `DropFsOps` so this can be unit tested without touching a real disk.

export interface DropDirEntry {
  name: string;
  isDirectory: boolean;
}

/** Filesystem operations needed to walk a dropped directory tree. */
export interface DropFsOps {
  /** List the immediate children of a directory. */
  readDir(path: string): Promise<DropDirEntry[]>;
  /** Byte size of a regular file. */
  size(path: string): Promise<number>;
  /** Join a native filesystem path with a child name. */
  joinPath(dirPath: string, childName: string): string;
}

export interface ExpandedDropFile {
  /** Native filesystem path, used to actually read the file's bytes. */
  path: string;
  /** "/"-joined relative name (includes the dropped folder's own name for
   *  files found inside a dropped directory); used to build the remote key. */
  name: string;
  size: number;
  /** Set when this file came from expanding a dropped directory — shared by
   *  every file under that same top-level drop, so the UI can group them
   *  into a single folder row instead of one row per file. Unset for a
   *  file dropped (or picked) on its own. */
  folderId?: string;
  /** Display name for the aggregated folder row — the dropped directory's
   *  own name. Only set alongside `folderId`. */
  folderName?: string;
}

export interface ExpandedDrop {
  files: ExpandedDropFile[];
  /** Native paths that couldn't be read (stat/size/readDir failed) and were
   *  skipped so the rest of the batch could still upload. */
  skipped: string[];
}

/** OS metadata litter that users never mean to upload. Filtered out during
 * expansion — also load-bearing on macOS, where a `.DS_Store` inside any
 * dropped folder would otherwise fail the Tauri fs scope check and abort
 * the whole batch. Compared case-insensitively. */
const OS_JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isJunkFile(name: string): boolean {
  return OS_JUNK_FILES.has(name.toLowerCase());
}

/** Returns the last path segment, tolerating both "/" and "\\" separators. */
export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

interface DropFolder {
  folderId: string;
  folderName: string;
}

async function walkDir(
  dirPath: string,
  relPrefix: string,
  ops: DropFsOps,
  out: ExpandedDrop,
  folder: DropFolder,
): Promise<void> {
  let entries: DropDirEntry[];
  try {
    entries = await ops.readDir(dirPath);
  } catch {
    out.skipped.push(dirPath);
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => !isJunkFile(entry.name))
      .map(async (entry) => {
        const childPath = ops.joinPath(dirPath, entry.name);
        const childRel = `${relPrefix}/${entry.name}`;
        if (entry.isDirectory) {
          await walkDir(childPath, childRel, ops, out, folder);
        } else {
          try {
            out.files.push({
              path: childPath,
              name: childRel,
              size: await ops.size(childPath),
              folderId: folder.folderId,
              folderName: folder.folderName,
            });
          } catch {
            out.skipped.push(childPath);
          }
        }
      }),
  );
}

/**
 * Expand a list of dropped paths (files and/or directories) into a flat
 * list of files. `isDirectory` is only consulted for the top-level dropped
 * paths (their kind isn't otherwise known); nested entries use the
 * `isDirectory` flag already returned by `ops.readDir`.
 *
 * A single unreadable item never fails the batch: it lands in `skipped`
 * and the remaining files still expand.
 */
export async function expandDroppedPaths(
  paths: string[],
  isDirectory: (path: string) => Promise<boolean>,
  ops: DropFsOps,
): Promise<ExpandedDrop> {
  const out: ExpandedDrop = { files: [], skipped: [] };
  await Promise.all(
    paths
      .filter((p) => !isJunkFile(basenameOf(p)))
      .map(async (p) => {
        let dir: boolean;
        try {
          dir = await isDirectory(p);
        } catch {
          out.skipped.push(p);
          return;
        }
        if (dir) {
          const folderName = basenameOf(p);
          await walkDir(p, folderName, ops, out, { folderId: crypto.randomUUID(), folderName });
        } else {
          try {
            out.files.push({ path: p, name: basenameOf(p), size: await ops.size(p) });
          } catch {
            out.skipped.push(p);
          }
        }
      }),
  );
  return out;
}
