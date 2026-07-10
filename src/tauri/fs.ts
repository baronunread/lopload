// Thin wrappers around @tauri-apps/plugin-fs implementing the engine's
// LocalFileReader/LocalFileWriter interfaces. Both stream chunk-by-chunk via
// open()+seek()/append()+read()/write() — a large file is never loaded whole
// into memory in either direction.

import {
  mkdir,
  open,
  remove,
  rename,
  SeekMode,
  size as fileSize,
  type FileHandle,
} from "@tauri-apps/plugin-fs";

import type { LocalFileReader } from "../lib/s3/multipart";
import type { LocalFileWriter } from "../lib/s3/download";

// writeAt() handle cache: ranged downloads hammer writeAt() once per coalesced
// buffer from several concurrent workers targeting the same temp file. Opening
// a fresh handle per call is 4 IPC round-trips (open/seek/write/close) to
// tauri-plugin-fs; instead we keep one open handle per temp path and reuse it.
//
// A handle has a single shared seek position, so concurrent seek+write pairs
// from different workers must never interleave — the mutex below chains every
// writeAt() for a given path onto a single promise, serializing its
// seek()+write() against all others for that path (while different temp paths
// still run fully in parallel).
const openHandles = new Map<string, Promise<FileHandle>>();
const writeQueues = new Map<string, Promise<void>>();

// Closes and evicts only the cached handle. Deliberately does NOT touch
// writeQueues: this is called from inside a queued writeAt() while its own
// promise is still the (possibly not-yet-current) tail of the chain, so
// removing the queue entry here could let a concurrently-arriving writeAt()
// believe there's nothing to wait on and run before this one's cleanup
// finishes. The queue is left to drain naturally; forgetPath() below does
// the full cleanup once the caller knows no writes are in flight.
async function evictHandle(tempPath: string): Promise<void> {
  const pending = openHandles.get(tempPath);
  openHandles.delete(tempPath);
  if (!pending) return;
  try {
    const handle = await pending;
    await handle.close();
  } catch {
    // Already closed/invalid — nothing to clean up.
  }
}

// Full cleanup for a temp path once the caller knows all writeAt() calls
// against it have settled (commit/discard run after the ranged download's
// worker pool has finished; allocate runs before a new attempt starts writing
// at all). Safe to drop the write-queue entry here since nothing is chained
// on it anymore.
async function forgetPath(tempPath: string): Promise<void> {
  await evictHandle(tempPath);
  writeQueues.delete(tempPath);
}

function getHandle(tempPath: string): Promise<FileHandle> {
  let handle = openHandles.get(tempPath);
  if (!handle) {
    handle = open(tempPath, { write: true });
    openHandles.set(tempPath, handle);
  }
  return handle;
}

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
    await forgetPath(tempPath);
    await ensureParentDir(finalPath);
    await rename(tempPath, finalPath);
  },

  async discard(tempPath: string): Promise<void> {
    await forgetPath(tempPath);
    try {
      await remove(tempPath);
    } catch {
      // Temp file may never have been created (e.g. failure before the first chunk).
    }
  },

  async allocate(tempPath: string, size: number): Promise<void> {
    // A cached handle from a previous attempt at this temp path would now be
    // seeking/writing against stale (pre-truncate) file content — drop it
    // first so the next writeAt() reopens against the freshly-truncated file.
    await forgetPath(tempPath);
    await ensureParentDir(tempPath);
    const file = await open(tempPath, { write: true, create: true, truncate: true });
    try {
      await file.truncate(size);
    } finally {
      await file.close();
    }
  },

  // Reuses one open handle per temp path across calls (instead of a fresh
  // open→seek→write→close per call) to avoid an IPC round-trip storm from
  // many small ranged-download writes. Since a handle has a single shared
  // seek position, concurrent writeAt() calls for the same path are chained
  // through a per-path mutex so each seek()+write() pair completes atomically
  // before the next one runs; different temp paths still proceed in parallel.
  async writeAt(tempPath: string, offset: number, chunk: Uint8Array): Promise<void> {
    const previous = writeQueues.get(tempPath) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // A prior write in the chain already failed and evicted the handle;
        // this write should still get a fresh attempt.
      })
      .then(async () => {
        try {
          const file = await getHandle(tempPath);
          await file.seek(offset, SeekMode.Start);
          let written = 0;
          while (written < chunk.length) {
            const n = await file.write(chunk.subarray(written));
            if (!n || n <= 0) {
              throw new Error(`Short write to ${tempPath} at offset ${offset + written}`);
            }
            written += n;
          }
        } catch (err) {
          // The handle (or its seek position) may now be in a bad state —
          // evict it so the next writeAt() reopens a fresh one.
          await evictHandle(tempPath);
          throw err;
        }
      });
    writeQueues.set(tempPath, next);
    return next;
  },

  async sizeOf(tempPath: string): Promise<number | null> {
    try {
      return await fileSize(tempPath);
    } catch {
      return null;
    }
  },
};
