import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  clearAllForTests,
  fetchFolderInfo,
  invalidateConnection,
  invalidateForKey,
  invalidateListing,
  peekFolderInfo,
  peekListing,
  putListing,
} from "../../../src/ui/listingCache";
import type { RemoteEntry } from "../../../src/lib/types";
import type { FolderInfo } from "../../../src/ui/services";

const FILE_A: RemoteEntry = { kind: "file", name: "a.txt", key: "a.txt", size: 1, lastModified: 1 };
const FILE_B: RemoteEntry = { kind: "file", name: "b.txt", key: "b.txt", size: 2, lastModified: 2 };

function folderInfo(files: number): FolderInfo {
  return { files, totalSize: files * 100, lastModified: Date.now() };
}

afterEach(() => {
  setSystemTime();
  clearAllForTests();
});

describe("listingCache", () => {
  describe("listings", () => {
    test("peekListing is a miss until putListing populates it", () => {
      expect(peekListing("conn-a", "")).toBeUndefined();
      putListing("conn-a", "", [FILE_A]);
      expect(peekListing("conn-a", "")).toEqual([FILE_A]);
    });

    test("keys are scoped per connection and per prefix", () => {
      putListing("conn-a", "", [FILE_A]);
      putListing("conn-a", "photos/", [FILE_B]);
      putListing("conn-b", "", [FILE_B]);
      expect(peekListing("conn-a", "")).toEqual([FILE_A]);
      expect(peekListing("conn-a", "photos/")).toEqual([FILE_B]);
      expect(peekListing("conn-b", "")).toEqual([FILE_B]);
    });

    test("expires entries after the TTL", () => {
      const start = Date.now();
      setSystemTime(new Date(start));
      putListing("conn-a", "", [FILE_A]);
      expect(peekListing("conn-a", "")).toEqual([FILE_A]);

      setSystemTime(new Date(start + 14 * 60 * 1000));
      expect(peekListing("conn-a", "")).toEqual([FILE_A]);

      setSystemTime(new Date(start + 16 * 60 * 1000));
      expect(peekListing("conn-a", "")).toBeUndefined();
    });

    test("invalidateListing drops a single cached listing", () => {
      putListing("conn-a", "", [FILE_A]);
      putListing("conn-a", "photos/", [FILE_B]);
      invalidateListing("conn-a", "");
      expect(peekListing("conn-a", "")).toBeUndefined();
      expect(peekListing("conn-a", "photos/")).toEqual([FILE_B]);
    });

    test("evicts the oldest half once past the cap, keeping recent entries", () => {
      const MAX_LISTINGS = 200;
      for (let i = 0; i < MAX_LISTINGS; i++) {
        putListing("conn-evict", `folder-${i}/`, [FILE_A]);
      }
      // Every entry is still fresh (no TTL expiry), so hitting the cap
      // should drop the oldest-inserted half rather than growing unbounded.
      putListing("conn-evict", "one-more/", [FILE_A]);

      let cached = 0;
      for (let i = 0; i < MAX_LISTINGS; i++) {
        if (peekListing("conn-evict", `folder-${i}/`) !== undefined) cached++;
      }
      expect(cached).toBeLessThan(MAX_LISTINGS);
      // The newest entries survive eviction.
      expect(peekListing("conn-evict", "one-more/")).toEqual([FILE_A]);
      expect(peekListing("conn-evict", `folder-${MAX_LISTINGS - 1}/`)).toEqual([FILE_A]);
    });
  });

  describe("folder info", () => {
    test("peekFolderInfo is a miss until fetchFolderInfo resolves", async () => {
      expect(peekFolderInfo("conn-a", "photos/")).toBeUndefined();
      const info = folderInfo(3);
      const result = await fetchFolderInfo("conn-a", "photos/", async () => info);
      expect(result).toEqual(info);
      expect(peekFolderInfo("conn-a", "photos/")).toEqual(info);
    });

    test("deduplicates concurrent requests for the same folder", async () => {
      let calls = 0;
      let release!: (info: FolderInfo) => void;
      const fetcher = () =>
        new Promise<FolderInfo>((resolve) => {
          calls++;
          release = resolve;
        });

      const first = fetchFolderInfo("conn-b", "photos/", fetcher);
      const second = fetchFolderInfo("conn-b", "photos/", fetcher);
      // One shared object: folderInfo() stamps lastModified with Date.now(),
      // so building it twice flakes whenever the ms clock ticks in between.
      const released = folderInfo(5);
      release(released);
      expect(await first).toEqual(released);
      expect(await second).toEqual(released);
      expect(calls).toBe(1);
    });

    test("does not cache failures, so the next attempt retries", async () => {
      let calls = 0;
      const failing = async (): Promise<FolderInfo> => {
        calls++;
        throw new Error("boom");
      };
      await expect(fetchFolderInfo("conn-c", "photos/", failing)).rejects.toThrow("boom");
      expect(peekFolderInfo("conn-c", "photos/")).toBeUndefined();

      const info = folderInfo(1);
      expect(await fetchFolderInfo("conn-c", "photos/", async () => info)).toEqual(info);
      expect(calls).toBe(1);
    });

    test("expires entries after the TTL", async () => {
      const start = Date.now();
      setSystemTime(new Date(start));
      const info = folderInfo(2);
      await fetchFolderInfo("conn-d", "photos/", async () => info);
      expect(peekFolderInfo("conn-d", "photos/")).toEqual(info);

      setSystemTime(new Date(start + 4 * 60 * 1000));
      expect(peekFolderInfo("conn-d", "photos/")).toEqual(info);

      setSystemTime(new Date(start + 6 * 60 * 1000));
      expect(peekFolderInfo("conn-d", "photos/")).toBeUndefined();
    });
  });

  describe("invalidateForKey", () => {
    test("drops the parent-prefix listing for a mutated file", () => {
      putListing("conn-a", "a/b/", [FILE_A]);
      invalidateForKey("conn-a", "a/b/c.txt");
      expect(peekListing("conn-a", "a/b/")).toBeUndefined();
    });

    test("drops the parent-prefix listing for a mutated folder", () => {
      putListing("conn-a", "a/", [FILE_A]);
      invalidateForKey("conn-a", "a/b/");
      expect(peekListing("conn-a", "a/")).toBeUndefined();
    });

    test("drops FolderInfo for every ancestor prefix, but not the mutated key's own listing/stats", async () => {
      await fetchFolderInfo("conn-a", "a/b/", async () => folderInfo(2));
      await fetchFolderInfo("conn-a", "a/", async () => folderInfo(5));
      putListing("conn-a", "a/b/", [FILE_A]); // the mutated file's own containing listing

      invalidateForKey("conn-a", "a/b/c.txt");

      // Ancestors of a/b/c.txt: a/b/ and a/ — both should be dropped since
      // their recursive aggregates now include (or exclude) the mutated file.
      expect(peekFolderInfo("conn-a", "a/b/")).toBeUndefined();
      expect(peekFolderInfo("conn-a", "a/")).toBeUndefined();
    });

    test("does not touch a different connection's cache", () => {
      putListing("conn-a", "a/b/", [FILE_A]);
      putListing("conn-x", "a/b/", [FILE_B]);
      invalidateForKey("conn-a", "a/b/c.txt");
      expect(peekListing("conn-a", "a/b/")).toBeUndefined();
      expect(peekListing("conn-x", "a/b/")).toEqual([FILE_B]);
    });

    test("root-level keys invalidate the root listing and stop (no ancestor beyond root)", () => {
      putListing("conn-a", "", [FILE_A]);
      invalidateForKey("conn-a", "readme.txt");
      expect(peekListing("conn-a", "")).toBeUndefined();
    });
  });

  describe("invalidateConnection", () => {
    test("drops every listing and folder info for the connection, leaving others intact", async () => {
      putListing("conn-a", "", [FILE_A]);
      putListing("conn-a", "photos/", [FILE_B]);
      await fetchFolderInfo("conn-a", "photos/", async () => folderInfo(1));
      putListing("conn-b", "", [FILE_B]);
      // Kept in a const for the same clock-tick reason as the inflight-dedupe
      // test above — this exact flake hit CI on a loaded runner (PR #22).
      const infoB = folderInfo(9);
      await fetchFolderInfo("conn-b", "photos/", async () => infoB);

      invalidateConnection("conn-a");

      expect(peekListing("conn-a", "")).toBeUndefined();
      expect(peekListing("conn-a", "photos/")).toBeUndefined();
      expect(peekFolderInfo("conn-a", "photos/")).toBeUndefined();

      expect(peekListing("conn-b", "")).toEqual([FILE_B]);
      expect(peekFolderInfo("conn-b", "photos/")).toEqual(infoB);
    });
  });
});
