// Minimal, dependency-free MD5 implementation.
//
// Why we roll our own: Bun/WebCrypto's SubtleCrypto does not implement MD5
// (it's not in the WebCrypto spec — only SHA-1/256/384/512). S3 ETags for
// single-part uploads and the composite multipart ETag are both MD5-based,
// so we need MD5 specifically, not just "a hash."
//
// This module supports incremental hashing (create/update/digest) so the
// multipart engine can feed it file chunks as they're read, without ever
// holding a whole file in memory.

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10,
  15, 21,
];

const K = new Int32Array([
  -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426,
  -1473231341, -45705983, 1770035416, -1958414417, -42063, -1990404162,
  1804603682, -40341101, -1502002290, 1236535329, -165796510, -1069501632,
  643717713, -373897302, -701558691, 38016083, -660478335, -405537848,
  568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784,
  1735328473, -1926607734, -378558, -2022574463, 1839030562, -35309556,
  -1530992060, 1272893353, -155497632, -1094730640, 681279174, -358537222,
  -722521979, 76029189, -640364487, -421815835, 530742520, -995338651,
  -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606,
  -1051523, -2054922799, 1873313359, -30611744, -1560198380, 1309151649,
  -145523070, -1120210379, 718787259, -343485551,
]);

function rotl(x: number, c: number): number {
  return (x << c) | (x >>> (32 - c));
}

/** Incremental MD5 hasher. Feed chunks via `update`, finish with `digest`. */
export class Md5 {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;
  private lengthBytes = 0;
  /** Buffered bytes not yet forming a full 64-byte block. */
  private buffer: Uint8Array = new Uint8Array(0);

  update(chunk: Uint8Array): void {
    this.lengthBytes += chunk.length;
    let data: Uint8Array;
    if (this.buffer.length > 0) {
      data = new Uint8Array(this.buffer.length + chunk.length);
      data.set(this.buffer, 0);
      data.set(chunk, this.buffer.length);
    } else {
      data = chunk;
    }
    const fullBlocks = Math.floor(data.length / 64);
    const processedLen = fullBlocks * 64;
    for (let i = 0; i < processedLen; i += 64) {
      this.processBlock(data, i);
    }
    this.buffer = data.slice(processedLen);
  }

  digest(): Uint8Array {
    const totalLenBits = this.lengthBytes * 8;
    // Padding: 0x80 then zeros then 8-byte little-endian bit length,
    // padded so total length is a multiple of 64.
    const remaining = this.buffer.length;
    const withPadLen = remaining + 1 + 8;
    const blockCount = Math.ceil(withPadLen / 64);
    const finalLen = blockCount * 64;
    const final = new Uint8Array(finalLen);
    final.set(this.buffer, 0);
    final[remaining] = 0x80;
    const view = new DataView(final.buffer);
    // JS numbers are safe integers up to 2^53; bit length as two 32-bit words.
    const lo = totalLenBits >>> 0;
    const hi = Math.floor(totalLenBits / 0x100000000) >>> 0;
    view.setUint32(finalLen - 8, lo, true);
    view.setUint32(finalLen - 4, hi, true);

    for (let i = 0; i < finalLen; i += 64) {
      this.processBlock(final, i);
    }

    const out = new Uint8Array(16);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, this.a >>> 0, true);
    outView.setUint32(4, this.b >>> 0, true);
    outView.setUint32(8, this.c >>> 0, true);
    outView.setUint32(12, this.d >>> 0, true);
    return out;
  }

  private processBlock(data: Uint8Array, offset: number): void {
    const view = new DataView(data.buffer, data.byteOffset + offset, 64);
    const M = new Int32Array(16);
    for (let j = 0; j < 16; j++) {
      M[j] = view.getInt32(j * 4, true);
    }

    let A = this.a;
    let B = this.b;
    let C = this.c;
    let D = this.d;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl(F, S[i])) | 0;
    }

    this.a = (this.a + A) | 0;
    this.b = (this.b + B) | 0;
    this.c = (this.c + C) | 0;
    this.d = (this.d + D) | 0;
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** One-shot MD5 of a full byte array, returned as lowercase hex. */
export function md5Hex(data: Uint8Array): string {
  const h = new Md5();
  h.update(data);
  return bytesToHex(h.digest());
}

/** MD5 of raw bytes, returned as raw digest bytes (for composite hashing). */
export function md5Bytes(data: Uint8Array): Uint8Array {
  const h = new Md5();
  h.update(data);
  return h.digest();
}

/**
 * S3's multipart ETag is `hex(md5(concat(raw md5 digest bytes of each
 * part)))-{partCount}`. Given the per-part md5 hex strings (in part-number
 * order), compute that composite value.
 */
export function compositeEtag(partMd5Hexes: string[]): string {
  const bytes = new Uint8Array(partMd5Hexes.length * 16);
  partMd5Hexes.forEach((hex, i) => {
    for (let j = 0; j < 16; j++) {
      bytes[i * 16 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
  });
  return `${md5Hex(bytes)}-${partMd5Hexes.length}`;
}
