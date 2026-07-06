// Pure trash key scheme + expiry math — no S3 client, no framework. The
// trash location for a deleted item is `.lopload-trash/<deletedAtMs>/<originalKey>`,
// in the same storage as everything else, hidden from normal browsing by
// convention (every listing call filters out this prefix). The timestamp in
// the path is the only record of when an item was deleted — no per-object
// metadata calls are needed to know when something should be purged.

export const TRASH_PREFIX = ".lopload-trash/";

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** True for any key living under the trash location, including the trash
 * root itself — used to filter every normal listing/download/filter path. */
export function isTrashKey(key: string): boolean {
  return key.startsWith(TRASH_PREFIX);
}

/** Builds the trash location for an item deleted at `deletedAtMs`. */
export function trashKey(deletedAtMs: number, originalKey: string): string {
  return `${TRASH_PREFIX}${deletedAtMs}/${originalKey}`;
}

export interface ParsedTrashKey {
  deletedAtMs: number;
  originalKey: string;
}

/** Inverse of trashKey(); null for anything not shaped like a trash entry.
 * Only the first "/" after the timestamp segment is significant, so the
 * original key can itself contain any number of slashes (nested folders)
 * or non-ASCII characters and still round-trip exactly. */
export function parseTrashKey(key: string): ParsedTrashKey | null {
  if (!key.startsWith(TRASH_PREFIX)) return null;
  const rest = key.slice(TRASH_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  const timestampSegment = rest.slice(0, slashIdx);
  if (!/^\d+$/.test(timestampSegment)) return null;
  const deletedAtMs = Number(timestampSegment);
  const originalKey = rest.slice(slashIdx + 1);
  if (!originalKey) return null;
  return { deletedAtMs, originalKey };
}

/** The instant an item deleted at `deletedAtMs` becomes eligible for the
 * silent purge sweep. */
export function purgeAt(deletedAtMs: number, retentionMs: number = TRASH_RETENTION_MS): number {
  return deletedAtMs + retentionMs;
}

/** Whether an item deleted at `deletedAtMs` is old enough to purge, as of `now`. */
export function isExpired(
  deletedAtMs: number,
  now: number,
  retentionMs: number = TRASH_RETENTION_MS,
): boolean {
  return now - deletedAtMs >= retentionMs;
}

/** One trashed storage object, as read back off a listing. */
export interface TrashObject {
  trashKey: string;
  originalKey: string;
  deletedAtMs: number;
  size: number;
}

/** One row for the trash view: a file, or an entire folder trashed as a
 * single action — restoring/deleting it acts on every object under
 * `members`. */
export interface TrashGroup {
  originalKey: string;
  kind: "file" | "folder";
  deletedAtMs: number;
  purgeAtMs: number;
  totalSize: number;
  members: string[];
}

function isAncestorPath(maybeAncestor: string, key: string): boolean {
  return maybeAncestor.endsWith("/") && key !== maybeAncestor && key.startsWith(maybeAncestor);
}

/**
 * Groups raw trashed objects into one row per originally-deleted item.
 * Objects sharing a `deletedAtMs` that nest under another object's
 * originalKey (folder deletes always include the folder's own marker, even
 * if it never had one before being deleted — see moveFolderToTrash) collapse
 * into a single "folder" row; everything else is its own "file" row.
 */
export function groupTrashObjects(objects: TrashObject[]): TrashGroup[] {
  const byTimestamp = new Map<number, TrashObject[]>();
  for (const obj of objects) {
    const bucket = byTimestamp.get(obj.deletedAtMs);
    if (bucket) bucket.push(obj);
    else byTimestamp.set(obj.deletedAtMs, [obj]);
  }

  const groups: TrashGroup[] = [];
  for (const [deletedAtMs, objs] of byTimestamp) {
    for (const candidate of objs) {
      const hasAncestorInGroup = objs.some((other) =>
        isAncestorPath(other.originalKey, candidate.originalKey),
      );
      if (hasAncestorInGroup) continue;

      const isFolder = candidate.originalKey.endsWith("/");
      const members = isFolder
        ? objs.filter(
            (o) => o.originalKey === candidate.originalKey || o.originalKey.startsWith(candidate.originalKey),
          )
        : [candidate];

      groups.push({
        originalKey: candidate.originalKey,
        kind: isFolder ? "folder" : "file",
        deletedAtMs,
        purgeAtMs: purgeAt(deletedAtMs),
        totalSize: members.reduce((sum, m) => sum + m.size, 0),
        members: members.map((m) => m.trashKey),
      });
    }
  }
  return groups;
}
