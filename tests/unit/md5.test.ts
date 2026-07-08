import { describe, expect, test } from "bun:test";
import { Md5, bytesToHex, md5Hex } from "../../src/lib/md5";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("md5", () => {
  test("known test vectors", async () => {
    expect(await md5Hex(utf8(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(await md5Hex(utf8("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(await md5Hex(utf8("The quick brown fox jumps over the lazy dog"))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });

  test("longer input spanning many 64-byte blocks", async () => {
    const big = new Uint8Array(1_000_000).fill(0x61);
    expect(await md5Hex(big)).toBe("7707d6ae4e027c70eea2a935c2296f21");
  });

  test("incremental update matches one-shot for the same bytes", async () => {
    const data = utf8("The quick brown fox jumps over the lazy dog");
    const oneShot = await md5Hex(data);

    const hasher = await Md5.create();
    hasher.update(data.slice(0, 10));
    hasher.update(data.slice(10, 20));
    hasher.update(data.slice(20));
    const incremental = bytesToHex(hasher.digest());

    expect(incremental).toBe(oneShot);
  });

  test("update across a block boundary in arbitrary chunk sizes", async () => {
    const data = new Uint8Array(200);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    const oneShot = await md5Hex(data);

    const hasher = await Md5.create();
    hasher.update(data.slice(0, 1));
    hasher.update(data.slice(1, 63));
    hasher.update(data.slice(63, 64));
    hasher.update(data.slice(64, 65));
    hasher.update(data.slice(65));
    expect(bytesToHex(hasher.digest())).toBe(oneShot);
  });

  test("concurrent hashers don't share state", async () => {
    const [a, b] = await Promise.all([Md5.create(), Md5.create()]);
    a.update(utf8("first"));
    b.update(utf8("second"));
    expect(bytesToHex(a.digest())).toBe(await md5Hex(utf8("first")));
    expect(bytesToHex(b.digest())).toBe(await md5Hex(utf8("second")));
  });
});
