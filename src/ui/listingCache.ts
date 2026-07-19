/**
 * Session-scoped stale-while-revalidate cache for folder listings and
 * per-folder stats (file count/size/last-modified), keyed by connection +
 * path. Mirrors thumbnailCache.ts's shape: module-level Maps, a synchronous
 * `peek` gated by TTL, inflight dedupe for the async folder-stats fetch, and
 * bounded eviction (oldest-inserted half once past the cap).
 *
 * Listings let navigation render instantly from cache (RemoteBrowser's
 * navigation effect) while a silent revalidate runs behind it. Folder stats
 * are recursive per-folder scans (one ListObjectsV2 walk per folder), so
 * they're worth remembering across navigations too — seeded synchronously
 * into folderMeta so sizes/dates show immediately on back-navigation instead
 * of flashing "—" while they recompute.
 */
import type { RemoteEntry } from "../lib/types";
import type { FolderInfo } from "./services";

/** Listings churn faster than folder aggregates (any upload/delete/move
 * changes one), but re-listing is cheap — a relatively short TTL just
 * bounds how long a completely idle tab can serve a stale listing before
 * the next navigation forces a real fetch regardless of revalidation. */
const LISTING_TTL_MS = 15 * 60 * 1000;
const MAX_LISTINGS = 200;

/** Folder stats are a recursive walk — expensive enough that a longer TTL
 * is worth the (small) risk of showing a slightly-stale aggregate for a
 * folder nobody's mutated recently. Mutations invalidate their ancestors
 * explicitly (see invalidateForKey), so this TTL only matters for changes
 * this app didn't make itself (another client, another machine). */
const FOLDER_INFO_TTL_MS = 5 * 60 * 1000;
const MAX_FOLDER_INFOS = 2000;

interface ListingEntry {
  entries: RemoteEntry[];
  fetchedAt: number;
}

interface FolderInfoEntry {
  info: FolderInfo;
  fetchedAt: number;
}

const listings = new Map<string, ListingEntry>();
const folderInfos = new Map<string, FolderInfoEntry>();
const folderInfoInflight = new Map<string, Promise<FolderInfo>>();

function cacheKey(connectionId: string, path: string): string {
  return `${connectionId} ${path}`;
}

/** Parent prefix of a key — strips the trailing name segment (and, for a
 * folder key, its own trailing slash first) to get the prefix whose listing
 * contains it. Root-level keys ("foo.txt", "foo/") return "". */
function parentPrefixOf(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? "" : trimmed.slice(0, idx + 1);
}

function evictOldestHalf<T extends { fetchedAt: number }>(
  map: Map<string, T>,
  ttlMs: number,
  max: number,
): void {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (now - entry.fetchedAt >= ttlMs) map.delete(key);
  }
  // Still full of live entries: drop the oldest-inserted half.
  if (map.size >= max) {
    let toDrop = Math.floor(max / 2);
    for (const key of map.keys()) {
      if (toDrop-- <= 0) break;
      map.delete(key);
    }
  }
}

/** Synchronous lookup; `undefined` means "not cached or expired". */
export function peekListing(connectionId: string, prefix: string): RemoteEntry[] | undefined {
  const key = cacheKey(connectionId, prefix);
  const entry = listings.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= LISTING_TTL_MS) {
    listings.delete(key);
    return undefined;
  }
  return entry.entries;
}

/** Records a freshly-fetched listing — called once a real ListObjectsV2 call
 * (spinner load or silent revalidate) succeeds. */
export function putListing(connectionId: string, prefix: string, entries: RemoteEntry[]): void {
  const key = cacheKey(connectionId, prefix);
  if (!listings.has(key) && listings.size >= MAX_LISTINGS) {
    evictOldestHalf(listings, LISTING_TTL_MS, MAX_LISTINGS);
  }
  listings.set(key, { entries, fetchedAt: Date.now() });
}

/** Drops a single cached listing — used by invalidateForKey below. */
export function invalidateListing(connectionId: string, prefix: string): void {
  listings.delete(cacheKey(connectionId, prefix));
}

/** Synchronous lookup; `undefined` means "not cached or expired". */
export function peekFolderInfo(connectionId: string, folderKey: string): FolderInfo | undefined {
  const key = cacheKey(connectionId, folderKey);
  const entry = folderInfos.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt >= FOLDER_INFO_TTL_MS) {
    folderInfos.delete(key);
    return undefined;
  }
  return entry.info;
}

/** Resolves a folder's stats, deduplicating concurrent requests for the same
 * folder — the folderMeta background effect and the folder-info dialog can
 * both want the same key at once — and caching the result. */
export function fetchFolderInfo(
  connectionId: string,
  folderKey: string,
  fetcher: () => Promise<FolderInfo>,
): Promise<FolderInfo> {
  const cached = peekFolderInfo(connectionId, folderKey);
  if (cached !== undefined) return Promise.resolve(cached);

  const key = cacheKey(connectionId, folderKey);
  const pending = folderInfoInflight.get(key);
  if (pending) return pending;

  const promise = fetcher().then(
    (info) => {
      folderInfoInflight.delete(key);
      if (!folderInfos.has(key) && folderInfos.size >= MAX_FOLDER_INFOS) {
        evictOldestHalf(folderInfos, FOLDER_INFO_TTL_MS, MAX_FOLDER_INFOS);
      }
      folderInfos.set(key, { info, fetchedAt: Date.now() });
      return info;
    },
    (err) => {
      folderInfoInflight.delete(key);
      throw err;
    },
  );
  folderInfoInflight.set(key, promise);
  return promise;
}

/** Drops a single cached folder-info entry — used by invalidateForKey below. */
function invalidateFolderInfo(connectionId: string, folderKey: string): void {
  folderInfos.delete(cacheKey(connectionId, folderKey));
}

/**
 * Drops the cached listing of `key`'s parent folder, plus the folder-info
 * stats of every ancestor prefix above it. Folder stats are recursive
 * aggregates, so a mutation anywhere under a folder (upload, delete, move,
 * rename, restore) makes every ancestor's totals stale, not just the
 * immediate parent's.
 */
export function invalidateForKey(connectionId: string, key: string): void {
  const parentPrefix = parentPrefixOf(key);
  invalidateListing(connectionId, parentPrefix);
  let ancestor = parentPrefix;
  while (ancestor !== "") {
    invalidateFolderInfo(connectionId, ancestor);
    ancestor = parentPrefixOf(ancestor);
  }
}

/** Drops every cached listing/folder-info for a connection — call when its
 * credentials, endpoint, or bucket change (an existing S3 client is being
 * torn down), since cached entries would otherwise keep serving data from
 * whatever the connection used to point at. */
export function invalidateConnection(connectionId: string): void {
  const prefix = cacheKey(connectionId, "");
  for (const key of listings.keys()) {
    if (key.startsWith(prefix)) listings.delete(key);
  }
  for (const key of folderInfos.keys()) {
    if (key.startsWith(prefix)) folderInfos.delete(key);
  }
  for (const key of folderInfoInflight.keys()) {
    if (key.startsWith(prefix)) folderInfoInflight.delete(key);
  }
}

/** Test-only: wipes every cache so unit tests don't leak state across cases
 * that reuse the same connection id. */
export function clearAllForTests(): void {
  listings.clear();
  folderInfos.clear();
  folderInfoInflight.clear();
}
