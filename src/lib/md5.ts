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

export async function md5Hex(data: Uint8Array): Promise<string> {
  const h = await Md5.create();
  h.update(data);
  return bytesToHex(h.digest());
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function compositeEtag(partEtags: string[]): Promise<string> {
  const h = await Md5.create();
  for (const etag of partEtags) {
    h.update(hexToBytes(etag));
  }
  return `${bytesToHex(h.digest())}-${partEtags.length}`;
}