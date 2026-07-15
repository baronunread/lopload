// Test-only LocalFileReader backed by node:fs. Doesn't need to be the real
// Tauri implementation (src/tauri/fs.ts) — just needs to satisfy the same
// LocalFileReader contract the engine depends on, reading real bytes off
// disk in chunks so large-file tests don't require loading the whole file
// into memory to build it either.

import { open, stat } from "node:fs/promises";
import type { LocalFileReader } from "../../src/lib/s3/multipart";

export const localFileReader: LocalFileReader = {
  async size(path: string): Promise<number> {
    const st = await stat(path);
    return st.size;
  },

  async readChunk(path: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await open(path, "r");
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};
