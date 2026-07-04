import { describe, expect, test } from "bun:test";
import { Md5, bytesToHex, compositeEtag, md5Hex } from "../../src/lib/md5";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("md5", () => {
  test("known test vectors", () => {
    expect(md5Hex(utf8(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(utf8("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(utf8("The quick brown fox jumps over the lazy dog"))).toBe(
      "9e107d9d372bb6826bd81d3542a419d6",
    );
  });

  test("longer input spanning many 64-byte blocks", () => {
    // 'a' repeated one million times is a canonical MD5 stress vector.
    const big = new Uint8Array(1_000_000).fill(0x61);
    expect(md5Hex(big)).toBe("7707d6ae4e027c70eea2a935c2296f21");
  });

  test("incremental update matches one-shot for the same bytes", () => {
    const data = utf8("The quick brown fox jumps over the lazy dog");
    const oneShot = md5Hex(data);

    const hasher = new Md5();
    hasher.update(data.slice(0, 10));
    hasher.update(data.slice(10, 20));
    hasher.update(data.slice(20));
    const incremental = bytesToHex(hasher.digest());

    expect(incremental).toBe(oneShot);
  });

  test("update across a block boundary in arbitrary chunk sizes", () => {
    const data = new Uint8Array(200);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    const oneShot = md5Hex(data);

    const hasher = new Md5();
    hasher.update(data.slice(0, 1));
    hasher.update(data.slice(1, 63));
    hasher.update(data.slice(63, 64));
    hasher.update(data.slice(64, 65));
    hasher.update(data.slice(65));
    expect(bytesToHex(hasher.digest())).toBe(oneShot);
  });

  test("compositeEtag combines part md5s and appends part count", () => {
    const part1 = md5Hex(utf8("part-one"));
    const part2 = md5Hex(utf8("part-two"));
    const combinedBytes = new Uint8Array(32);
    [part1, part2].forEach((hex, i) => {
      for (let j = 0; j < 16; j++) {
        combinedBytes[i * 16 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
      }
    });
    const expected = `${md5Hex(combinedBytes)}-2`;
    expect(compositeEtag([part1, part2])).toBe(expected);
  });
});
