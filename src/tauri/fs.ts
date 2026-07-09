// Thin wrappers around @tauri-apps/plugin-fs implementing the engine's
// LocalFileReader/LocalFileWriter interfaces. Both stream chunk-by-chunk via
// open()+seek()/append()+read()/write() — a large file is never loaded whole
// into memory in either direction.

import { mkdir, open, remove, rename, SeekMode, size as fileSize } from "@tauri-apps/plugin-fs";

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
    const file = await open(
      tempPath,
      isFirst ? { write: true, create: true, truncate: true } : { write: true, append: true },
    );
    try {
      await file.write(chunk);
    } finally {
      await file.close();
    }
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

  // Opens a fresh handle per call (open → seek → write → close), so
  // concurrent calls at different offsets never share a seek position.
  async writeAt(tempPath: string, offset: number, chunk: Uint8Array): Promise<void> {
    const file = await open(tempPath, { write: true });
    try {
      await file.seek(offset, SeekMode.Start);
      let written = 0;
      while (written < chunk.length) {
        const n = await file.write(chunk.subarray(written));
        if (!n || n <= 0) {
          throw new Error(`Short write to ${tempPath} at offset ${offset + written}`);
        }
        written += n;
      }
    } finally {
      await file.close();
    }
  },

  async sizeOf(tempPath: string): Promise<number | null> {
    try {
      return await fileSize(tempPath);
    } catch {
      return null;
    }
  },
};
