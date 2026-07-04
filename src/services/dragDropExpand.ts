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
}

/** Returns the last path segment, tolerating both "/" and "\\" separators. */
export function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

async function walkDir(
  dirPath: string,
  relPrefix: string,
  ops: DropFsOps,
  out: ExpandedDropFile[],
): Promise<void> {
  const entries = await ops.readDir(dirPath);
  for (const entry of entries) {
    const childPath = ops.joinPath(dirPath, entry.name);
    const childRel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory) {
      await walkDir(childPath, childRel, ops, out);
    } else {
      out.push({ path: childPath, name: childRel, size: await ops.size(childPath) });
    }
  }
}

/**
 * Expand a list of dropped paths (files and/or directories) into a flat
 * list of files. `isDirectory` is only consulted for the top-level dropped
 * paths (their kind isn't otherwise known); nested entries use the
 * `isDirectory` flag already returned by `ops.readDir`.
 */
export async function expandDroppedPaths(
  paths: string[],
  isDirectory: (path: string) => Promise<boolean>,
  ops: DropFsOps,
): Promise<ExpandedDropFile[]> {
  const out: ExpandedDropFile[] = [];
  for (const p of paths) {
    if (await isDirectory(p)) {
      const baseName = basenameOf(p);
      await walkDir(p, baseName, ops, out);
    } else {
      out.push({ path: p, name: basenameOf(p), size: await ops.size(p) });
    }
  }
  return out;
}
