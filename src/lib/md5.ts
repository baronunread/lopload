// MD5 via hash-wasm (WASM, incremental). WebCrypto's SubtleCrypto does not
// implement MD5 (it's not in the WebCrypto spec — only SHA-1/256/384/512),
// and S3 ETags for single-part uploads are MD5-based, so we need MD5
// specifically, not just "a hash."
//
// Incremental hashing (create/update/digest) lets the transfer engines feed
// file chunks as they're read, without ever holding a whole file in memory.
// hash-wasm's hasher construction is async (WASM module load, cached after
// the first call), hence the async factories on an otherwise-sync API.

import { createMD5 } from "hash-wasm";

export class Md5 {
  private constructor(
    private readonly hasher: Awaited<ReturnType<typeof createMD5>>,
  ) {}

  static async create(): Promise<Md5> {
    const hasher = await createMD5();
    hasher.init();
    return new Md5(hasher);
  }

  update(chunk: Uint8Array): void {
    this.hasher.update(chunk);
  }

  digest(): Uint8Array {
    return this.hasher.digest("binary");
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** One-shot MD5 of a full byte array, returned as lowercase hex. */
export async function md5Hex(data: Uint8Array): Promise<string> {
  const h = await Md5.create();
  h.update(data);
  return bytesToHex(h.digest());
}
