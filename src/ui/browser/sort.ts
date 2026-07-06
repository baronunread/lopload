import type { RemoteEntry } from "../../lib/types";

export type SortKey = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";

export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortState = { key: "name", direction: "asc" };

/** Clicking a header that's already active flips direction; clicking a new
 * header starts it ascending. */
export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

function compareByName(a: RemoteEntry, b: RemoteEntry): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function compareValues(a: RemoteEntry, b: RemoteEntry, key: SortKey): number {
  switch (key) {
    case "name":
      return compareByName(a, b);
    case "size":
      return (a.size ?? 0) - (b.size ?? 0);
    case "modified":
      return (a.lastModified ?? 0) - (b.lastModified ?? 0);
  }
}

/** Sorts a folder's listing per `sort`, always keeping folders ahead of files
 * regardless of which column/direction is active. Ties (e.g. folders, which
 * have no size or modified date) fall back to name order. */
export function sortEntries(entries: RemoteEntry[], sort: SortState): RemoteEntry[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  const folders = entries.filter((e) => e.kind === "folder");
  const files = entries.filter((e) => e.kind === "file");
  const byActiveSort = (a: RemoteEntry, b: RemoteEntry) =>
    direction * compareValues(a, b, sort.key) || compareByName(a, b);
  return [...folders.sort(byActiveSort), ...files.sort(byActiveSort)];
}
