// Thin wrappers around @tauri-apps/plugin-fs implementing the engine's
// LocalFileReader/LocalFileWriter interfaces. Both stream chunk-by-chunk — a
// large file is never loaded whole into memory in either direction.
//
// Writes deliberately avoid plugin-fs's FileHandle.write(): it passes the
// chunk nested inside a JSON args object, and Tauri's IPC serializer expands a
// nested Uint8Array into an array of numbers and JSON-stringifies it, so a
// 2 MiB write crosses the boundary as ~9 MB of decimal text. Tauri only takes
// its raw-bytes path when the payload *is* the TypedArray, which means the
// bytes must be the entire invoke argument and the path/offset must travel as
// headers. writeAt() uses our own `write_at` command (src-tauri/src/fastfs.rs)
// for that; writeChunk() uses plugin-fs's writeFile(), which is the one
// plugin-fs API already shaped that way.

import {
  mkdir,
  open,
  remove,
  rename,
  SeekMode,
  size as fileSize,
  writeFile,
} from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

import type { LocalFileReader } from "../lib/s3/multipart";
import type { LocalFileWriter } from "../lib/s3/download";

export const tauriFileReader: LocalFileReader = {
  async size(path: string): Promise<number> {
    return fileSize(path);
  },

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const file = await open(path, { read: true });
    try {
      await file.seek(offset, SeekMode.Start);
      const buffer = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const read = await file.read(buffer.subarray(filled));
        if (read === null || read === 0) break;
        filled += read;
      }
      return filled === length ? buffer : buffer.subarray(0, filled);
    } finally {
      await file.close();
    }
  },
};

/** Parent of a native path, so both separators count. A root keeps its
 * separator: "/x" → "/", "D:\\x" → "D:\\". */
export function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx < 0) return ".";
  if (idx === 0 || path[idx - 1] === ":") return path.slice(0, idx + 1);
  return path.slice(0, idx);
}

// Tauri's fs scope grants exactly the paths the user pointed at: the save
// dialog allows the destination file, not the `.lopload-download` sibling
// written next to it, and a download folder remembered from a previous run was
// never picked in this session at all. Neither is covered by the static scope
// in capabilities/default.json unless the destination happens to sit under
// $HOME — on Windows a destination on any drive other than the user profile's
// is forbidden outright. So the destination folder is granted (in memory, for
// this run only) before the app touches anything inside it. Memoized because
// every write goes through here and only the first one needs the IPC.
const allowedDirs = new Set<string>();

async function allowDirOf(path: string): Promise<string> {
  const dir = dirnameOf(path);
  if (!allowedDirs.has(dir)) {
    await invoke("allow_fs_dir", { path: dir });
    allowedDirs.add(dir);
  }
  return dir;
}

async function ensureParentDir(path: string): Promise<void> {
  const dir = await allowDirOf(path);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Already exists — fine.
  }
}

export const tauriFileWriter: LocalFileWriter = {
  tempPathFor(finalPath: string): string {
    return `${finalPath}.lopload-download`;
  },

  async writeChunk(tempPath: string, chunk: Uint8Array, isFirst: boolean): Promise<void> {
    if (isFirst) await ensureParentDir(tempPath);
    else await allowDirOf(tempPath);
    // append:false truncates, which is exactly the isFirst contract.
    await writeFile(tempPath, chunk, { create: true, append: !isFirst });
  },

  async commit(tempPath: string, finalPath: string): Promise<void> {
    await ensureParentDir(finalPath);
    await rename(tempPath, finalPath);
  },

  async discard(tempPath: string): Promise<void> {
    try {
      await allowDirOf(tempPath);
      await remove(tempPath);
    } catch {
      // Temp file may never have been created (e.g. failure before the first chunk).
    }
  },

  async allocate(tempPath: string, size: number): Promise<void> {
    await ensureParentDir(tempPath);
    const file = await open(tempPath, { write: true, create: true, truncate: true });
    try {
      await file.truncate(size);
    } finally {
      await file.close();
    }
  },

  // The chunk is the whole invoke payload (Tauri's raw-bytes path); the
  // destination rides along as headers, percent-encoded because HTTP headers
  // are ASCII-only and paths are not. Each call opens its own descriptor in
  // Rust, so concurrent ranged workers writing non-overlapping offsets don't
  // share a seek position and need no locking here.
  async writeAt(tempPath: string, offset: number, chunk: Uint8Array): Promise<void> {
    await invoke("write_at", chunk, {
      headers: {
        path: encodeURIComponent(tempPath),
        offset: String(offset),
      },
    });
  },

  async sizeOf(tempPath: string): Promise<number | null> {
    try {
      // Without the grant this throws, which reads as "no temp file" and
      // silently restarts a resumable download from byte zero.
      await allowDirOf(tempPath);
      return await fileSize(tempPath);
    } catch {
      return null;
    }
  },
};
