import type { RemoteEntry } from "../../lib/types";

/** Narrows the current folder's rows by a case-insensitive substring match
 * on name. Never recurses into subfolders — it only filters what's already
 * listed. */
export function filterEntries(entries: RemoteEntry[], query: string): RemoteEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}
