// Test-only LocalFileWriter backed by node:fs. Doesn't need to be the real
// Tauri implementation (src/tauri/fs.ts) — just needs to satisfy the same
// LocalFileWriter contract the engine depends on, streaming chunks to a temp
// sibling file and renaming it into place on commit.

import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalFileWriter } from "../../src/lib/s3/download";

export const localFileWriter: LocalFileWriter = {
  tempPathFor(finalPath: string): string {
    return `${finalPath}.lopload-download`;
  },

  async writeChunk(tempPath: string, chunk: Uint8Array, isFirst: boolean): Promise<void> {
    if (isFirst) await mkdir(dirname(tempPath), { recursive: true });
    const handle = await open(tempPath, isFirst ? "w" : "a");
    try {
      await handle.write(chunk);
    } finally {
      await handle.close();
    }
  },

  async commit(tempPath: string, finalPath: string): Promise<void> {
    await mkdir(dirname(finalPath), { recursive: true });
    await rename(tempPath, finalPath);
  },

  async discard(tempPath: string): Promise<void> {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Temp file may never have been created (e.g. failure before the first chunk).
    }
  },
};
