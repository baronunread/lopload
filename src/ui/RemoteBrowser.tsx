import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, LazyMotion, domAnimation, m } from "motion/react";
import { Button, Empty, useKumoToastManager } from "@cloudflare/kumo";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { Connection, RemoteEntry } from "../lib/types";
import { mapWithConcurrency } from "../lib/concurrency";
import { segmentsForPrefix } from "./format";
import { CredentialsUnreadableError, useServices, type FolderInfo } from "./services";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { CredentialsReentryForm } from "./CredentialsReentryForm";
import {
  fetchFolderInfo,
  invalidateForKey,
  peekFolderInfo,
  peekListing,
  putListing,
} from "./listingCache";
import { DragGhost } from "./browser/DragGhost";
import {
  EntryInfoDialog,
  PendingActionDialog,
  type FolderInfoState,
  type PendingAction,
} from "./browser/RemoteBrowserDialogs";
import { RemoteBrowserBreadcrumbs } from "./browser/RemoteBrowserBreadcrumbs";
import { RemoteBrowserTable } from "./browser/RemoteBrowserTable";
import { RemoteBrowserToolbar } from "./browser/RemoteBrowserToolbar";
import { filterEntries } from "./browser/filter";
import { DEFAULT_SORT, nextSortState, sortEntries, type SortKey } from "./browser/sort";
import { useDragMove } from "./browser/useDragMove";
import { useSelection } from "./browser/useSelection";

const MoveToDialog = lazy(() => import("./browser/MoveToDialog").then((m) => ({ default: m.MoveToDialog })));
const ShareLinkDialog = lazy(() => import("./browser/ShareLinkDialog").then((m) => ({ default: m.ShareLinkDialog })));
const TrashDialog = lazy(() => import("./browser/TrashDialog").then((m) => ({ default: m.TrashDialog })));

export interface RemoteBrowserProps {
  connectionId: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}

/** Cap on concurrent S3 operations kicked off from a single bulk UI action
 * (drag-moving or Trash-ing a multi-row selection). Each operation is
 * already its own recursive, internally-parallel copy/delete (see
 * OBJECT_CONCURRENCY/DELETE_CONCURRENCY in s3/client.ts) — this just bounds
 * how many of those run at once so selecting hundreds of rows can't fan out
 * into hundreds of unbounded folder operations simultaneously. */
const BULK_OP_CONCURRENCY = 3;

/** How long to wait, after the last relevant engine event, before re-listing
 * the current folder — batches of many files each finishing individually
 * would otherwise trigger a re-list per file. */
const REFRESH_DEBOUNCE_MS = 500;

/** The folder-row prefix under the given window point, if any. Folder rows
 * tag themselves with data-drop-prefix; containment is checked against their
 * rects directly (rather than elementFromPoint) because the drop overlay
 * sits above the table for the whole drag. Zero-size rects are skipped so
 * unrendered rows can never match. */
function folderPrefixAtPoint(x: number, y: number): string | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-drop-prefix]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return el.dataset.dropPrefix ?? null;
    }
  }
  return null;
}

/** Compares two listings by content (key/kind/size/lastModified) rather than
 * identity — used to skip a re-render when a silent revalidate's response
 * matches what's already on screen, so a cache-hit navigation followed by a
 * no-op revalidate doesn't visibly re-render the table. Key-based rather
 * than index-based so it's insensitive to incidental reordering. */
function entriesEqual(a: RemoteEntry[], b: RemoteEntry[]): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((entry) => [entry.key, entry]));
  return a.every((entry) => {
    const other = byKey.get(entry.key);
    return (
      other !== undefined &&
      other.kind === entry.kind &&
      other.size === entry.size &&
      other.lastModified === entry.lastModified
    );
  });
}

/** Remote folder browser: breadcrumbs, listing table, thumbnails, and a right-click menu. */
export function RemoteBrowser({ connectionId, prefix, onNavigate }: RemoteBrowserProps) {
  const services = useServices();
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [credentialsConnection, setCredentialsConnection] = useState<Connection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: RemoteEntry } | null>(
    null,
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [infoEntry, setInfoEntry] = useState<RemoteEntry | null>(null);
  const [folderInfoState, setFolderInfoState] = useState<FolderInfoState | null>(null);
  const [dragging, setDragging] = useState(false);
  // The folder row an OS file drag is currently hovering, as an upload
  // target prefix — null means "drop uploads to the current folder". The
  // ref mirrors the state for the drop callback, which fires from the host
  // (not React) after async path expansion.
  const [osDropPrefix, setOsDropPrefix] = useState<string | null>(null);
  const osDropPrefixRef = useRef<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [showTrash, setShowTrash] = useState(false);
  const [moveTargets, setMoveTargets] = useState<string[] | null>(null);
  const [shareEntry, setShareEntry] = useState<RemoteEntry | null>(null);
  const [folderMeta, setFolderMeta] = useState<Record<string, FolderInfo>>({});
  const toasts = useKumoToastManager();

  const rows = sortEntries(filterEntries(entries, filterQuery), sort);
  const selection = useSelection(rows);

  // What the drop overlay names as the upload destination: the hovered
  // folder row if there is one, otherwise the folder currently open.
  const dropTargetSegments = segmentsForPrefix(osDropPrefix ?? prefix);
  const dropTargetLabel = dropTargetSegments[dropTargetSegments.length - 1] ?? "Home";

  // Every list request (spinner or silent) carries an incrementing id, so a
  // slow/stale response can never clobber a newer one that already landed —
  // otherwise an optimistic mutation followed by a fast re-list could be
  // overwritten by an in-flight refresh() that was kicked off before it.
  const requestIdRef = useRef(0);

  // Whether the current connectionId+prefix has ever produced a successful
  // listing. Reset on navigation. Once true, a later refresh — e.g. the
  // debounced re-list after an upload lands — must never blank the table on
  // failure: a transient error under transfer load (or a stale-credentials
  // hiccup) would otherwise make an already-loaded folder flash empty. Stale
  // data beats no data; only the very first load for a location shows the
  // error/empty UI.
  const loadedRef = useRef(false);

  /** Applies an optimistic update to `entries` immediately and returns a
   * rollback that applies the given inverse — inverse-ops rather than a
   * whole-array snapshot, so rolling back one mutation can't clobber another
   * optimistic mutation that landed concurrently. */
  function mutateEntries(
    apply: (prev: RemoteEntry[]) => RemoteEntry[],
    invert: (prev: RemoteEntry[]) => RemoteEntry[],
  ): () => void {
    setEntries(apply);
    return () => setEntries(invert);
  }

  /**
   * `revalidatingCache`, when true, marks this as the silent revalidate that
   * follows a cache-hit navigation (see the effect below) rather than a
   * post-mutation reconcile. It's the one silent-path exception to "keep
   * whatever's on screen on failure": a CredentialsUnreadableError isn't
   * transient (a keychain ACL mismatch, say, or a denied prompt), and
   * papering over it with stale cached data would trap the user on a frozen
   * listing with no way to reconnect. Any other failure still keeps the
   * cached listing, same as an ordinary silent refresh.
   */
  async function runList(spinner: boolean, revalidatingCache = false) {
    const requestId = ++requestIdRef.current;
    if (spinner) setLoading(true);
    try {
      const result = await services.browser.list(connectionId, prefix);
      if (requestId !== requestIdRef.current) return;
      putListing(connectionId, prefix, result);
      setEntries((prev) => (entriesEqual(prev, result) ? prev : result));
      setLoadFailed(false);
      setCredentialsConnection(null);
      loadedRef.current = true;
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      const isCredentialsError = err instanceof CredentialsUnreadableError;
      if (!spinner && !(revalidatingCache && isCredentialsError)) return;
      // A re-list of an already-loaded folder failed — keep showing the last
      // good listing instead of blanking it. Only a location's first load
      // (nothing on screen to preserve yet) falls through to the error UI.
      if (spinner && loadedRef.current) return;
      if (spinner) setEntries([]);
      if (isCredentialsError) {
        // The OS keychain couldn't produce credentials for this connection
        // (denied prompt, or an ACL mismatch after a signing identity
        // change) — offer plain re-entry instead of a broken listing.
        const connections = await services.connections.list();
        const conn = connections.find((c) => c.id === connectionId) ?? null;
        setCredentialsConnection(conn);
        setLoadFailed(conn === null);
      } else {
        // e.g. an unreachable endpoint — surface a retryable error state
        // instead of an unhandled rejection.
        setCredentialsConnection(null);
        setLoadFailed(true);
      }
    } finally {
      if (requestId === requestIdRef.current && spinner) setLoading(false);
    }
  }

  /** Full re-list with the loading spinner — for navigation and initial
   * load. */
  async function refresh() {
    await runList(true);
  }

  /** Same fetch as refresh(), but without flipping on the loading spinner and
   * without clearing the listing on failure — used to reconcile after an
   * optimistic mutation already updated `entries` locally. */
  async function refreshSilently() {
    await runList(false);
  }

  useEffect(() => {
    loadedRef.current = false;
    const cached = peekListing(connectionId, prefix);
    if (cached !== undefined) {
      // Instant render from cache, then a silent revalidate behind it — the
      // existing requestIdRef stale-guard and loadedRef keep-last-good
      // behavior in runList() apply exactly as they do for any other
      // silent refresh. revalidatingCache=true so a credentials failure
      // still surfaces the re-entry flow instead of freezing on stale data.
      setEntries(cached);
      setLoadFailed(false);
      setCredentialsConnection(null);
      setLoading(false);
      loadedRef.current = true;
      void runList(false, true);
    } else {
      void refresh();
    }
    selection.clear();
    setFilterQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  useEffect(() => {
    const clearDragState = () => {
      setDragging(false);
      setOsDropPrefix(null);
      osDropPrefixRef.current = null;
    };
    return services.onFileDrop(
      (files) => {
        // Read the hovered folder before clearing: dropping on a folder row
        // uploads into that folder, anywhere else into the current one.
        const target = osDropPrefixRef.current ?? prefix;
        clearDragState();
        void services.engine.enqueueFiles(connectionId, target, files);
      },
      (message) => {
        clearDragState();
        toasts.add({
          variant: "error",
          title: "Some of what you dropped couldn't be added",
          description: message,
        });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  // Drives the drop overlay and per-folder-row targeting off the host's
  // native drag hover events (position while dragging, null on leave) —
  // DOM drag events are unreliable under Tauri, where wry intercepts the
  // native drop handling to emit these events instead.
  useEffect(() => {
    return services.onFileDragHover((position) => {
      if (position === null) {
        setDragging(false);
        setOsDropPrefix(null);
        osDropPrefixRef.current = null;
        return;
      }
      setDragging(true);
      const target = folderPrefixAtPoint(position.x, position.y);
      osDropPrefixRef.current = target;
      setOsDropPrefix(target);
    });
  }, [services]);

  // Escape clears the filter first, then (on a subsequent press) the
  // selection — wherever focus happens to be.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (filterQuery) {
        setFilterQuery("");
        return;
      }
      selection.clear();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);

  // Cmd/Ctrl+A selects every visible row (like Finder/Explorer) instead of
  // the document's text — unless focus is in a text field, where select-all
  // keeps its native meaning.
  useEffect(() => {
    function handleSelectAll(e: KeyboardEvent) {
      if (e.key !== "a" || !(e.metaKey || e.ctrlKey)) return;
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      selection.setSelected(new Set(rows.map((r) => r.key)));
    }
    document.addEventListener("keydown", handleSelectAll);
    return () => document.removeEventListener("keydown", handleSelectAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // S3 folders carry no size/date of their own, so after every listing the
  // stats for each folder row are computed in the background (one recursive
  // list per folder) and fill in as they arrive; rows show "—" meanwhile.
  useEffect(() => {
    let cancelled = false;
    // Seed synchronously from cache (instant sizes/dates on back-navigation)
    // and otherwise keep whatever's already on screen while fresh stats
    // compute — only drop folders that are no longer listed. Blanking
    // everything to "—" made every folder row visibly reload on each
    // upload-completion refresh.
    setFolderMeta((prev) => {
      const next: Record<string, FolderInfo> = {};
      for (const entry of entries) {
        if (entry.kind !== "folder") continue;
        const cached = peekFolderInfo(connectionId, entry.key);
        if (cached !== undefined) next[entry.key] = cached;
        else if (prev[entry.key]) next[entry.key] = prev[entry.key];
      }
      return next;
    });
    for (const entry of entries) {
      if (entry.kind !== "folder") continue;
      if (peekFolderInfo(connectionId, entry.key) !== undefined) continue;
      void fetchFolderInfo(connectionId, entry.key, () =>
        services.browser.folderInfo(connectionId, entry.key),
      ).then((info) => {
        if (!cancelled) setFolderMeta((prev) => ({ ...prev, [entry.key]: info }));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // Computes the folder info dialog's stats on demand once it's opened for a
  // folder — S3 "folders" have no metadata of their own to show up-front.
  useEffect(() => {
    if (!infoEntry || infoEntry.kind !== "folder") {
      setFolderInfoState(null);
      return;
    }
    let cancelled = false;
    const cached = peekFolderInfo(connectionId, infoEntry.key);
    setFolderInfoState(cached !== undefined ? { status: "loaded", ...cached } : { status: "loading" });
    // Shares the same inflight fetch (and cache) as the folderMeta background
    // effect above when both want this folder's stats at once.
    void fetchFolderInfo(connectionId, infoEntry.key, () =>
      services.browser.folderInfo(connectionId, infoEntry.key),
    ).then((result) => {
      if (!cancelled) setFolderInfoState({ status: "loaded", ...result });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoEntry, connectionId]);

  // Auto-refresh the listing once uploads land, so the user never has to
  // navigate away and back to see new files. Debounced so a large batch
  // (many "uploaded" events in a row) triggers one re-list, not dozens —
  // and silent, because flipping the spinner mid-upload makes the table
  // visibly reload for every file that lands.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshSilently();
      }, REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = services.engine.subscribe((event) => {
      if (event.type === "batch-finished") {
        scheduleRefresh();
      } else if (
        event.type === "transfer-updated" &&
        event.transfer.state.kind === "uploaded" &&
        event.transfer.key.startsWith(prefix)
      ) {
        invalidateForKey(event.transfer.connectionId, event.transfer.key);
        scheduleRefresh();
      }
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  async function handlePick() {
    const files = await services.pickFiles();
    if (files.length > 0) {
      await services.engine.enqueueFiles(connectionId, prefix, files);
    }
  }

  /** Downloads a single file (native "Save as" dialog) or a whole folder
   * recursively (native folder picker, recreating the folder's own name and
   * structure inside the chosen destination). */
  async function handleDownload(entry: RemoteEntry) {
    if (entry.kind === "file") {
      const destination = await services.pickSaveDestination(entry.name);
      if (!destination) return;
      await services.engine.enqueueDownloads(connectionId, [
        { key: entry.key, localPath: destination, size: entry.size ?? 0 },
      ]);
      return;
    }

    const destDir = await services.pickDownloadDirectory();
    if (!destDir) return;
    const files = await services.browser.listFilesRecursive(connectionId, entry.key);
    if (files.length === 0) return;
    const root = `${destDir}/${entry.name}`;
    await services.engine.enqueueDownloads(
      connectionId,
      files.map((f) => ({
        key: f.key,
        localPath: `${root}/${f.key.slice(entry.key.length)}`,
        size: f.size,
      })),
    );
  }

  /** Downloads every selected row into one chosen destination directory:
   * files land directly in it, folders are recreated recursively under
   * their own names — a single picker for the whole selection. */
  async function handleBulkDownload(selected: RemoteEntry[]) {
    const destDir = await services.pickDownloadDirectory();
    if (!destDir) return;
    const perEntry = await Promise.all(
      selected.map(async (entry) => {
        if (entry.kind === "file") {
          return [
            {
              key: entry.key,
              localPath: `${destDir}/${entry.name}`,
              size: entry.size ?? 0,
            },
          ];
        }
        const files = await services.browser.listFilesRecursive(connectionId, entry.key);
        const root = `${destDir}/${entry.name}`;
        return files.map((f) => ({
          key: f.key,
          localPath: `${root}/${f.key.slice(entry.key.length)}`,
          size: f.size,
        }));
      }),
    );
    const downloads = perEntry.flat();
    if (downloads.length === 0) return;
    await services.engine.enqueueDownloads(connectionId, downloads);
  }

  function navigate(next: string) {
    onNavigate(next);
    void services.connections.setLastPrefix(connectionId, next);
  }

  /** Resolves `fromKey` (a row's full path) to its destination key under
   * `toPrefix`, keeping its own name — or null for a no-op move (missing
   * entry, or destination equal to its current location). */
  function resolveMoveTarget(fromKey: string, toPrefix: string): string | null {
    if (!fromKey || fromKey === toPrefix) return null;
    const entry = entries.find((e) => e.key === fromKey);
    if (!entry) return null;
    // Folder destinations must keep the trailing slash — both backends
    // splice child keys as `toKey + rest`, so "docs/photos" (no slash)
    // would silently corrupt every moved key.
    const toKey =
      entry.kind === "folder" ? `${toPrefix}${entry.name}/` : `${toPrefix}${entry.name}`;
    if (toKey === fromKey) return null;
    return toKey;
  }

  /** Moves every dragged key to live under `toPrefix` — a single row, or the
   * whole selection when dragging one of several selected rows. Rows that
   * resolve to a no-op (missing entry, or already at `toPrefix`) are left
   * alone. Runs in the background — progress is shown in TransferWidget via
   * BrowserService.subscribeMoves. */
  async function handleMove(fromKeys: string[], toPrefix: string) {
    const moves = fromKeys
      .map((fromKey) => {
        const toKey = resolveMoveTarget(fromKey, toPrefix);
        return toKey ? { fromKey, toKey } : null;
      })
      .filter((m): m is { fromKey: string; toKey: string } => m !== null);
    if (moves.length === 0) return;

    const movedKeys = new Set(moves.map((m) => m.fromKey));
    const removed = entries.filter((e) => movedKeys.has(e.key));
    const rollback = mutateEntries(
      (prev) => prev.filter((e) => !movedKeys.has(e.key)),
      (prev) => [...prev, ...removed.filter((r) => !prev.some((e) => e.key === r.key))],
    );

    let anyFailed = false;
    const batchTotal = moves.length;
    void mapWithConcurrency(moves, BULK_OP_CONCURRENCY, async (m) => {
      try {
        await services.browser.move(connectionId, m.fromKey, m.toKey, undefined, batchTotal);
      } catch (err) {
        anyFailed = true;
        toasts.add({
          variant: "error",
          title: "Couldn't move",
          description: err instanceof Error ? err.message : "Something went wrong.",
        });
      }
    }).then(() => {
      if (anyFailed) rollback();
      for (const m of moves) {
        invalidateForKey(connectionId, m.fromKey);
        invalidateForKey(connectionId, m.toKey);
      }
      void refreshSilently();
    });
  }

  const dragMove = useDragMove({ onMove: handleMove });

  /** Moves an item to the Trash — low-stakes enough (it's recoverable via
   * the Trash view) that it doesn't need a confirmation dialog, unlike
   * Delete now/Empty trash there. */
  async function handleDeleteToTrash(entry: RemoteEntry) {
    const rollback = mutateEntries(
      (prev) => prev.filter((e) => e.key !== entry.key),
      (prev) => (prev.some((e) => e.key === entry.key) ? prev : [...prev, entry]),
    );
    selection.clear();
    try {
      await services.browser.delete(connectionId, entry.key);
      invalidateForKey(connectionId, entry.key);
      await refreshSilently();
    } catch (err) {
      rollback();
      toasts.add({
        variant: "error",
        title: "Couldn't move to Trash",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  async function handleBulkDeleteToTrash(deleted: RemoteEntry[]) {
    const deletedKeys = new Set(deleted.map((e) => e.key));
    const rollback = mutateEntries(
      (prev) => prev.filter((e) => !deletedKeys.has(e.key)),
      (prev) => [...prev, ...deleted.filter((d) => !prev.some((e) => e.key === d.key))],
    );
    selection.clear();
    let anyFailed = false;
    const batchTotal = deleted.length;
    void mapWithConcurrency(deleted, BULK_OP_CONCURRENCY, async (entry) => {
      try {
        await services.browser.delete(connectionId, entry.key, batchTotal);
      } catch (err) {
        anyFailed = true;
        toasts.add({
          variant: "error",
          title: "Couldn't move to Trash",
          description: err instanceof Error ? err.message : "Something went wrong.",
        });
      }
    }).then(() => {
      if (anyFailed) rollback();
      for (const entry of deleted) invalidateForKey(connectionId, entry.key);
      void refreshSilently();
    });
  }

  function contextItemsFor(entry?: RemoteEntry): ContextMenuItem[] {
    // Right-clicking a row that's part of a multi-row selection offers bulk
    // actions on the whole selection instead of the usual single-entry menu.
    if (entry && selection.selected.has(entry.key) && selection.selected.size > 1) {
      const selectedEntries = rows.filter((r) => selection.selected.has(r.key));
      return [
        {
          label: `Download ${selectedEntries.length} items`,
          onSelect: () => void handleBulkDownload(selectedEntries),
        },
        {
          label: `Move ${selectedEntries.length} items to…`,
          onSelect: () => setMoveTargets(selectedEntries.map((r) => r.key)),
        },
        {
          label: `Move ${selectedEntries.length} items to Trash`,
          danger: true,
          onSelect: () => void handleBulkDeleteToTrash(selectedEntries),
        },
      ];
    }

    const items: ContextMenuItem[] = [
      {
        label: "New folder",
        onSelect: () => {
          setPendingName("");
          setPending({ kind: "new-folder" });
        },
      },
    ];
    if (entry) {
      items.unshift(
        {
          label: "Rename",
          onSelect: () => {
            setPendingName(entry.name);
            setPending({ kind: "rename", entry });
          },
        },
        {
          label: "Download",
          onSelect: () => void handleDownload(entry),
        },
        {
          label: "Move to…",
          onSelect: () => setMoveTargets([entry.key]),
        },
        ...(entry.kind === "file"
          ? [{ label: "Copy link…", onSelect: () => setShareEntry(entry) }]
          : []),
        {
          label: entry.kind === "folder" ? "Folder info" : "File info",
          onSelect: () => setInfoEntry(entry),
        },
      );
      items.push({
        label: "Move to Trash",
        danger: true,
        onSelect: () => void handleDeleteToTrash(entry),
      });
    }
    return items;
  }

  function handleRowMouseDown(entry: RemoteEntry, e: ReactMouseEvent) {
    const isFolder = entry.kind === "folder";
    const isSelected = selection.selected.has(entry.key);
    const isMultiDrag = isSelected && selection.selected.size > 1;
    const dragKeys = isMultiDrag ? Array.from(selection.selected) : [entry.key];
    // Single-file drags reuse the row's rendered thumbnail (if it has one)
    // so the chip shows the file itself rather than a generic glyph.
    const thumbnailSrc =
      dragKeys.length === 1 && !isFolder && e.currentTarget instanceof HTMLElement
        ? (e.currentTarget.querySelector("img")?.src ?? undefined)
        : undefined;
    dragMove.beginPress(e, {
      keys: dragKeys,
      label: dragKeys.length > 1 ? `${dragKeys.length} items` : entry.name,
      variant: dragKeys.length > 1 ? "files" : isFolder ? "folder" : "file",
      thumbnailSrc,
      fileName: dragKeys.length === 1 && !isFolder ? entry.name : undefined,
      onBegin: () => {
        if (!isMultiDrag) selection.setSelected(new Set([entry.key]));
      },
    });
  }

  function handleRowDoubleClick(entry: RemoteEntry) {
    if (entry.kind === "folder") navigate(entry.key);
    else setInfoEntry(entry);
  }

  function handleRowActionsClick(entry: RemoteEntry, e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom, entry });
  }

  function handleRowContextMenu(entry: RemoteEntry, e: ReactMouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }

  async function confirmPending() {
    if (!pending) return;
    const current = pending;
    const name = pendingName;
    setPending(null);

    if (current.kind === "new-folder") {
      const newEntry: RemoteEntry = { kind: "folder", name, key: `${prefix}${name}/` };
      const rollback = mutateEntries(
        (prev) => [...prev, newEntry],
        (prev) => prev.filter((e) => e.key !== newEntry.key),
      );
      try {
        await services.browser.createFolder(connectionId, prefix, name);
        invalidateForKey(connectionId, newEntry.key);
        await refreshSilently();
      } catch (err) {
        rollback();
        toasts.add({
          variant: "error",
          title: "Couldn't create folder",
          description: err instanceof Error ? err.message : "Something went wrong.",
        });
      }
      return;
    }

    // Rename: both entries live in the same current-folder listing, so the
    // renamed key is just the current prefix plus the new name (folders keep
    // their trailing slash).
    const { entry } = current;
    const newKey = entry.kind === "folder" ? `${prefix}${name}/` : `${prefix}${name}`;
    const rollback = mutateEntries(
      (prev) => prev.map((e) => (e.key === entry.key ? { ...e, name, key: newKey } : e)),
      (prev) => prev.map((e) => (e.key === newKey ? { ...e, name: entry.name, key: entry.key } : e)),
    );
    try {
      await services.browser.rename(connectionId, entry.key, name);
      invalidateForKey(connectionId, entry.key);
      invalidateForKey(connectionId, newKey);
      await refreshSilently();
    } catch (err) {
      rollback();
      toasts.add({
        variant: "error",
        title: "Couldn't rename",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  function handleSortChange(key: SortKey) {
    setSort((current) => nextSortState(current, key));
  }

  return (
    <div
      className="relative flex h-full flex-col gap-3"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      // OS file drags are tracked via the host's native drag events (see the
      // onFileDragHover effect) — these handlers only stop the webview's
      // default behavior if an HTML5 drag ever reaches the DOM anyway.
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
      }}
      // Deselect-on-background-click, for mouse users; Escape (handled in
      // the effect above) is the keyboard equivalent, so this wrapper isn't
      // itself an interaction target and doesn't need a role.
      onClick={() => selection.clear()}
    >
      <div className="flex items-center justify-between gap-2">
        <RemoteBrowserBreadcrumbs
          prefix={prefix}
          navigate={navigate}
          dragActive={dragMove.drag !== null}
          dropTarget={dragMove.dropTarget}
          dropTargetHandlers={dragMove.dropTargetHandlers}
        />
        <RemoteBrowserToolbar
          filterQuery={filterQuery}
          onFilterChange={setFilterQuery}
          onNewFolder={() => {
            setPendingName("");
            setPending({ kind: "new-folder" });
          }}
          onShowTrash={() => setShowTrash(true)}
          onUpload={() => void handlePick()}
        />
      </div>

      {credentialsConnection ? (
        <CredentialsReentryForm
          connection={credentialsConnection}
          onSaved={() => void refresh()}
          onCancel={() => {
            setCredentialsConnection(null);
            setLoadFailed(true);
          }}
        />
      ) : loadFailed ? (
        <Empty
          title="Couldn't load this storage"
          description="Check the connection's details and credentials, then try again."
          contents={
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      ) : !loading && entries.length === 0 ? (
        <Empty title="This folder is empty" description="Drag files in, or use Upload." />
      ) : !loading && rows.length === 0 ? (
        <Empty
          title="No matches"
          description="Nothing in this folder matches your filter."
          contents={
            <div className="flex justify-center">
              <MagnifyingGlassIcon size={20} className="text-kumo-subtle" />
            </div>
          }
        />
      ) : (
        <RemoteBrowserTable
          rows={rows}
          connectionId={connectionId}
          selected={selection.selected}
          dropTarget={dragMove.dropTarget ?? osDropPrefix}
          menuTargetKey={menu?.entry?.key ?? null}
          menuOpen={menu !== null}
          folderMeta={folderMeta}
          dropTargetHandlersFor={(entry) =>
            entry.kind === "folder" ? dragMove.dropTargetHandlers(entry.key) : undefined
          }
          onRowClick={(entry, e) => {
            e.stopPropagation();
            selection.handleRowClick(entry, e);
          }}
          onRowMouseDown={handleRowMouseDown}
          onRowDoubleClick={handleRowDoubleClick}
          onRowContextMenu={handleRowContextMenu}
          onRowActionsClick={handleRowActionsClick}
          sort={sort}
          onSortChange={handleSortChange}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={contextItemsFor(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      <PendingActionDialog
        pending={pending}
        pendingName={pendingName}
        onNameChange={setPendingName}
        onConfirm={() => void confirmPending()}
        onClose={() => setPending(null)}
      />

      <EntryInfoDialog infoEntry={infoEntry} folderInfoState={folderInfoState} onClose={() => setInfoEntry(null)} />

      <LazyMotion features={domAnimation}>
        <AnimatePresence>
          {dragging && (
            <m.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-kumo-brand/15"
            >
              <m.div
                aria-hidden
                className="absolute inset-1 rounded-lg ring-2 ring-dashed ring-kumo-brand"
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              />
              <p className="lopload-heading rounded-lg bg-kumo-base/85 px-4 py-2 text-lg font-semibold text-kumo-default shadow-lg">
                Drop to upload to{" "}
                <span className="text-kumo-brand">{dropTargetLabel}</span>
              </p>
            </m.div>
          )}
        </AnimatePresence>
      </LazyMotion>

      <DragGhost drag={dragMove.drag} ghostRef={dragMove.ghostRef} />

      {moveTargets && (
        <Suspense fallback={null}>
          <MoveToDialog
            connectionId={connectionId}
            sourceKeys={moveTargets}
            currentPrefix={prefix}
            onClose={() => setMoveTargets(null)}
            onMove={handleMove}
          />
        </Suspense>
      )}

      {shareEntry && (
        <Suspense fallback={null}>
          <ShareLinkDialog
            connectionId={connectionId}
            fileKey={shareEntry.key}
            fileName={shareEntry.name}
            onClose={() => setShareEntry(null)}
          />
        </Suspense>
      )}

      {showTrash && (
        <Suspense fallback={null}>
          <TrashDialog
            connectionId={connectionId}
            onClose={() => setShowTrash(false)}
            onRestored={(originalKey) => {
              invalidateForKey(connectionId, originalKey);
              void refresh();
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
