// In-memory stand-in for @tauri-apps/plugin-fs, backing src/tauri/fs.ts's
// tauriFileReader/tauriFileWriter for the service conformance suite. Only
// the surface real.ts and tauri/fs.ts actually call is implemented.

export interface FakeFsModule {
  size(path: string): Promise<number>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeTextFile(path: string, data: string, opts?: { append?: boolean; create?: boolean }): Promise<void>;
  SeekMode: { Start: number; Current: number; End: number };
  open(
    path: string,
    opts: { read?: boolean; write?: boolean; create?: boolean; append?: boolean; truncate?: boolean },
  ): Promise<{
    seek(offset: number, mode: number): Promise<void>;
    read(buffer: Uint8Array): Promise<number | null>;
    write(bytes: Uint8Array): Promise<number>;
    close(): Promise<void>;
  }>;
}

/** Builds a fake fs module backed by `files` (path -> bytes) — pre-populate
 * it with source files before an upload, and read back written files after
 * a download completes. */
export function createFakeFsModule(files: Map<string, Uint8Array>): FakeFsModule {
  return {
    async size(path) {
      const data = files.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return data.length;
    },
    async stat() {
      return { isDirectory: false };
    },
    async readDir() {
      return [];
    },
    async mkdir() {},
    async writeTextFile(path, data, opts) {
      if (opts?.create && !files.has(path)) {
        files.set(path, new TextEncoder().encode(data));
      } else if (opts?.append) {
        const existing = files.get(path);
        if (existing) {
          const merged = new Uint8Array(existing.length + data.length);
          merged.set(existing);
          merged.set(new TextEncoder().encode(data), existing.length);
          files.set(path, merged);
        } else {
          files.set(path, new TextEncoder().encode(data));
        }
      } else {
        files.set(path, new TextEncoder().encode(data));
      }
    },
    async remove(path) {
      files.delete(path);
    },
    async rename(from, to) {
      const data = files.get(from);
      if (data) files.set(to, data);
      files.delete(from);
    },
    SeekMode: { Start: 0, Current: 1, End: 2 },
    async open(path, opts) {
      let position = 0;
      if (opts.write) {
        if (opts.truncate || !files.has(path)) files.set(path, new Uint8Array(0));
        if (opts.append) position = files.get(path)?.length ?? 0;
      }
      return {
        async seek(offset) {
          position = offset;
        },
        async read(buffer) {
          const data = files.get(path);
          if (!data) return null;
          const remaining = data.length - position;
          if (remaining <= 0) return null;
          const toRead = Math.min(buffer.length, remaining);
          buffer.set(data.subarray(position, position + toRead));
          position += toRead;
          return toRead;
        },
        async write(bytes) {
          const existing = files.get(path) ?? new Uint8Array(0);
          const merged = new Uint8Array(Math.max(existing.length, position) + bytes.length);
          merged.set(existing.subarray(0, Math.min(existing.length, position)), 0);
          merged.set(bytes, position);
          files.set(path, merged);
          position += bytes.length;
          return bytes.length;
        },
        async close() {},
      };
    },
  };
}
