import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { fetchThumbnailUrl, peekThumbnailUrl } from "../../../src/ui/thumbnailCache";

afterEach(() => {
  setSystemTime();
});

describe("thumbnailCache", () => {
  test("caches the resolved URL and serves later requests without refetching", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return "https://example.com/signed-1";
    };

    expect(peekThumbnailUrl("conn-a", "one.png")).toBeUndefined();
    expect(await fetchThumbnailUrl("conn-a", "one.png", fetcher)).toBe("https://example.com/signed-1");
    expect(await fetchThumbnailUrl("conn-a", "one.png", fetcher)).toBe("https://example.com/signed-1");
    expect(peekThumbnailUrl("conn-a", "one.png")).toBe("https://example.com/signed-1");
    expect(calls).toBe(1);
  });

  test("deduplicates concurrent requests for the same object", async () => {
    let calls = 0;
    let release!: (url: string) => void;
    const fetcher = () =>
      new Promise<string | null>((resolve) => {
        calls++;
        release = resolve;
      });

    const first = fetchThumbnailUrl("conn-b", "two.png", fetcher);
    const second = fetchThumbnailUrl("conn-b", "two.png", fetcher);
    release("https://example.com/signed-2");
    expect(await first).toBe("https://example.com/signed-2");
    expect(await second).toBe("https://example.com/signed-2");
    expect(calls).toBe(1);
  });

  test("caches null (not previewable) without treating it as a miss", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return null;
    };

    expect(await fetchThumbnailUrl("conn-c", "three.bin", fetcher)).toBeNull();
    expect(peekThumbnailUrl("conn-c", "three.bin")).toBeNull();
    expect(await fetchThumbnailUrl("conn-c", "three.bin", fetcher)).toBeNull();
    expect(calls).toBe(1);
  });

  test("does not cache failures, so the next attempt retries", async () => {
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("boom");
    };

    await expect(fetchThumbnailUrl("conn-d", "four.png", failing)).rejects.toThrow("boom");
    expect(peekThumbnailUrl("conn-d", "four.png")).toBeUndefined();
    expect(
      await fetchThumbnailUrl("conn-d", "four.png", async () => {
        calls++;
        return "https://example.com/signed-4";
      }),
    ).toBe("https://example.com/signed-4");
    expect(calls).toBe(2);
  });

  test("expires entries after the TTL so stale presigned URLs are re-signed", async () => {
    const start = Date.now();
    setSystemTime(new Date(start));
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return `https://example.com/signed-5-${calls}`;
    };

    expect(await fetchThumbnailUrl("conn-e", "five.png", fetcher)).toBe("https://example.com/signed-5-1");
    setSystemTime(new Date(start + 31 * 60 * 1000));
    expect(peekThumbnailUrl("conn-e", "five.png")).toBeUndefined();
    expect(await fetchThumbnailUrl("conn-e", "five.png", fetcher)).toBe("https://example.com/signed-5-2");
    expect(calls).toBe(2);
  });

  test("keys are scoped per connection", async () => {
    expect(await fetchThumbnailUrl("conn-f", "same.png", async () => "url-f")).toBe("url-f");
    expect(await fetchThumbnailUrl("conn-g", "same.png", async () => "url-g")).toBe("url-g");
  });
});
