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

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

async function ensureParentDir(path: string): Promise<void> {
  try {
    await mkdir(dirnameOf(path), { recursive: true });
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
    // append:false truncates, which is exactly the isFirst contract.
    await writeFile(tempPath, chunk, { create: true, append: !isFirst });
  },

  async commit(tempPath: string, finalPath: string): Promise<void> {
    await ensureParentDir(finalPath);
    await rename(tempPath, finalPath);
  },

  async discard(tempPath: string): Promise<void> {
    try {
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
      return await fileSize(tempPath);
    } catch {
      return null;
    }
  },
};
