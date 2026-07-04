// Thin wrapper around @tauri-apps/plugin-fs implementing the engine's
// LocalFileReader interface. Reads chunks via open()+seek()+read() — a
// large file is never loaded whole into memory.

import { open, SeekMode, size as fileSize } from "@tauri-apps/plugin-fs";

import type { LocalFileReader } from "../lib/s3/multipart";

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
