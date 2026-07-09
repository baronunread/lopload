import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Breadcrumbs,
  Button,
  Dialog,
  Empty,
  Input,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  FolderPlusIcon,
  HouseIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Connection, RemoteEntry } from "../lib/types";
import { CredentialsUnreadableError, useServices, type FolderInfo } from "./services";
import { formatBytes, formatDate, segmentsForPrefix } from "./format";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { CredentialsReentryForm } from "./CredentialsReentryForm";
import { DragGhost } from "./browser/DragGhost";
import { MoveToDialog } from "./browser/MoveToDialog";
import { RemoteBrowserTable } from "./browser/RemoteBrowserTable";
import { ShareLinkDialog } from "./browser/ShareLinkDialog";
import { TrashDialog } from "./browser/TrashDialog";
import { filterEntries } from "./browser/filter";
import { DEFAULT_SORT, nextSortState, sortEntries, type SortKey } from "./browser/sort";
import { useDragMove } from "./browser/useDragMove";
import { useSelection } from "./browser/useSelection";

export interface RemoteBrowserProps {
  connectionId: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}

type PendingAction = { kind: "new-folder" } | { kind: "rename"; entry: RemoteEntry };

type FolderInfoState = { status: "loading" } | ({ status: "loaded" } & FolderInfo);

/** Breadcrumb ancestors are drop targets during a drag-to-move: every
 * candidate gets a dashed hint ring so it reads as droppable at all, and
 * the hovered one lights up like folder rows do. Idle crumbs keep a
 * transparent box (never `display: contents` — backgrounds and rings don't
 * render on a box-less element). */
function crumbDropClass(dragActive: boolean, isTarget: boolean): string {
  const base = "inline-flex items-center rounded-md px-1 py-0.5 ring-inset";
  if (!dragActive) return base;
  return isTarget
    ? `${base} bg-kumo-brand/20 ring-1 ring-kumo-brand`
    : `${base} ring-1 ring-dashed ring-kumo-line`;
}

/** How long to wait, after the last relevant engine event, before re-listing
 * the current folder — batches of many files each finishing individually
 * would otherwise trigger a re-list per file. */
const REFRESH_DEBOUNCE_MS = 500;

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
  const dragCounter = useRef(0);
  const [filterQuery, setFilterQuery] = useState("");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [showTrash, setShowTrash] = useState(false);
  const [moveTargets, setMoveTargets] = useState<string[] | null>(null);
  const [shareEntry, setShareEntry] = useState<RemoteEntry | null>(null);
  const [folderMeta, setFolderMeta] = useState<Record<string, FolderInfo>>({});
  const toasts = useKumoToastManager();

  const rows = sortEntries(filterEntries(entries, filterQuery), sort);
  const selection = useSelection(rows);
  const segments = segmentsForPrefix(prefix);

  async function refresh() {
    setLoading(true);
    try {
      const result = await services.browser.list(connectionId, prefix);
      setEntries(result);
      setLoadFailed(false);
      setCredentialsConnection(null);
    } catch (err) {
      setEntries([]);
      if (err instanceof CredentialsUnreadableError) {
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
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    selection.clear();
    setFilterQuery("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  useEffect(() => {
    return services.onFileDrop(
      (files) => {
        setDragging(false);
        dragCounter.current = 0;
        void services.engine.enqueueFiles(connectionId, prefix, files);
      },
      (message) => {
        setDragging(false);
        dragCounter.current = 0;
        toasts.add({
          variant: "error",
          title: "Some of what you dropped couldn't be added",
          description: message,
        });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

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
    setFolderMeta({});
    for (const entry of entries) {
      if (entry.kind !== "folder") continue;
      void services.browser.folderInfo(connectionId, entry.key).then((info) => {
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
    setFolderInfoState({ status: "loading" });
    void services.browser.folderInfo(connectionId, infoEntry.key).then((result) => {
      if (!cancelled) setFolderInfoState({ status: "loaded", ...result });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoEntry, connectionId]);

  // Auto-refresh the listing once uploads land, so the user never has to
  // navigate away and back to see new files. Debounced so a large batch
  // (many "uploaded" events in a row) triggers one re-list, not dozens.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
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
    const downloads: { key: string; localPath: string; size: number }[] = [];
    for (const entry of selected) {
      if (entry.kind === "file") {
        downloads.push({
          key: entry.key,
          localPath: `${destDir}/${entry.name}`,
          size: entry.size ?? 0,
        });
        continue;
      }
      const files = await services.browser.listFilesRecursive(connectionId, entry.key);
      const root = `${destDir}/${entry.name}`;
      for (const f of files) {
        downloads.push({
          key: f.key,
          localPath: `${root}/${f.key.slice(entry.key.length)}`,
          size: f.size,
        });
      }
    }
    if (downloads.length === 0) return;
    await services.engine.enqueueDownloads(connectionId, downloads);
  }

  function navigate(next: string) {
    onNavigate(next);
    void services.connections.setLastPrefix(connectionId, next);
  }

  /** Moves `fromKey` (a row's full path) to live under `toPrefix` instead,
   * keeping its own name. */
  async function moveOne(fromKey: string, toPrefix: string): Promise<void> {
    if (!fromKey || fromKey === toPrefix) return;
    const entry = entries.find((e) => e.key === fromKey);
    if (!entry) return;
    // Folder destinations must keep the trailing slash — both backends
    // splice child keys as `toKey + rest`, so "docs/photos" (no slash)
    // would silently corrupt every moved key.
    const toKey =
      entry.kind === "folder" ? `${toPrefix}${entry.name}/` : `${toPrefix}${entry.name}`;
    if (toKey === fromKey) return;
    await services.browser.move(connectionId, fromKey, toKey);
  }

  /** Moves every dragged key to live under `toPrefix` — a single row, or the
   * whole selection when dragging one of several selected rows. */
  async function handleMove(fromKeys: string[], toPrefix: string) {
    try {
      await Promise.all(fromKeys.map((key) => moveOne(key, toPrefix)));
    } catch (err) {
      toasts.add({
        variant: "error",
        title: "Couldn't move",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
    await refresh();
  }

  const dragMove = useDragMove({ onMove: handleMove });

  /** Moves an item to the Trash — low-stakes enough (it's recoverable via
   * the Trash view) that it doesn't need a confirmation dialog, unlike
   * Delete now/Empty trash there. */
  async function handleDeleteToTrash(entry: RemoteEntry) {
    try {
      await services.browser.delete(connectionId, entry.key);
      selection.clear();
      await refresh();
    } catch (err) {
      toasts.add({
        variant: "error",
        title: "Couldn't move to Trash",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
  }

  async function handleBulkDeleteToTrash(entries: RemoteEntry[]) {
    try {
      await Promise.all(entries.map((entry) => services.browser.delete(connectionId, entry.key)));
      selection.clear();
      await refresh();
    } catch (err) {
      toasts.add({
        variant: "error",
        title: "Couldn't move to Trash",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
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
    if (pending.kind === "new-folder") {
      await services.browser.createFolder(connectionId, prefix, pendingName);
    } else if (pending.kind === "rename") {
      await services.browser.rename(connectionId, pending.entry.key, pendingName);
    }
    setPending(null);
    await refresh();
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
      // Internal row moves are pointer-driven (see useDragMove), so any
      // HTML5 drag reaching these handlers is an OS file drag — show the
      // upload overlay.
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
      }}
      onClick={() => selection.clear()}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Breadcrumbs>
          <span
            className={crumbDropClass(dragMove.drag !== null, dragMove.dropTarget === "")}
            onClick={(e) => {
              e.preventDefault();
              navigate("");
            }}
            {...dragMove.dropTargetHandlers("")}
          >
            <Breadcrumbs.Link href="#" icon={<HouseIcon size={16} />}>
              Home
            </Breadcrumbs.Link>
          </span>
          {segments.map((segment, i) => {
            const segPrefix = segments.slice(0, i + 1).join("/") + "/";
            const isLast = i === segments.length - 1;
            return (
              <span key={segPrefix} className="contents">
                <Breadcrumbs.Separator />
                {isLast ? (
                  <Breadcrumbs.Current>{segment}</Breadcrumbs.Current>
                ) : (
                  <span
                    className={crumbDropClass(
                      dragMove.drag !== null,
                      dragMove.dropTarget === segPrefix,
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(segPrefix);
                    }}
                    {...dragMove.dropTargetHandlers(segPrefix)}
                  >
                    <Breadcrumbs.Link href="#">{segment}</Breadcrumbs.Link>
                  </span>
                )}
              </span>
            );
          })}
        </Breadcrumbs>
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            placeholder="Filter"
            aria-label="Filter this folder"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="w-36"
            onClick={(e) => e.stopPropagation()}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={FolderPlusIcon}
            onClick={() => {
              setPendingName("");
              setPending({ kind: "new-folder" });
            }}
          >
            New folder
          </Button>
          <Button variant="secondary" size="sm" icon={TrashIcon} onClick={() => setShowTrash(true)}>
            Trash
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={UploadSimpleIcon}
            onClick={() => void handlePick()}
          >
            Upload
          </Button>
        </div>
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
          dropTarget={dragMove.dropTarget}
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

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        {pending && (
          <Dialog className="p-6">
            <div className="flex items-center gap-3">
              <Dialog.Title className="m-0">
                {pending.kind === "new-folder" ? "New folder" : "Rename"}
              </Dialog.Title>
              <Dialog.Close
                render={(p) => (
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Close"
                    icon={XIcon}
                    className="ml-auto"
                    {...p}
                  />
                )}
              />
            </div>
            <Input
              label="Name"
              value={pendingName}
              onChange={(e) => setPendingName(e.target.value)}
              autoFocus
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="primary"
                disabled={!pendingName.trim()}
                onClick={() => void confirmPending()}
              >
                Save
              </Button>
            </div>
          </Dialog>
        )}
      </Dialog.Root>

      <Dialog.Root
        open={infoEntry !== null}
        onOpenChange={(open) => {
          if (!open) setInfoEntry(null);
        }}
      >
        {infoEntry && (
          <Dialog className="p-6">
            <div className="flex items-center gap-3">
              <Dialog.Title className="m-0">
                {infoEntry.kind === "folder" ? "Folder info" : "File info"}
              </Dialog.Title>
              <Dialog.Close
                render={(p) => (
                  <Button
                    variant="ghost"
                    shape="square"
                    aria-label="Close"
                    icon={XIcon}
                    className="ml-auto"
                    {...p}
                  />
                )}
              />
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm selectable">
              <dt className="text-kumo-subtle">Name</dt>
              <dd className="break-all">{infoEntry.name}</dd>
              <dt className="text-kumo-subtle">Path</dt>
              <dd className="break-all">{infoEntry.key}</dd>
              <dt className="text-kumo-subtle">Type</dt>
              <dd>{infoEntry.kind}</dd>
              {infoEntry.kind === "folder" ? (
                <>
                  <dt className="text-kumo-subtle">Details</dt>
                  <dd>
                    {folderInfoState?.status === "loaded"
                      ? `${folderInfoState.files} file${folderInfoState.files === 1 ? "" : "s"}, ${formatBytes(
                          folderInfoState.totalSize,
                        )}, last changed ${formatDate(folderInfoState.lastModified ?? undefined)}`
                      : "Loading…"}
                  </dd>
                </>
              ) : (
                <>
                  <dt className="text-kumo-subtle">Size</dt>
                  <dd>{formatBytes(infoEntry.size ?? 0)}</dd>
                  <dt className="text-kumo-subtle">Modified</dt>
                  <dd>{formatDate(infoEntry.lastModified)}</dd>
                </>
              )}
            </dl>
          </Dialog>
        )}
      </Dialog.Root>

      {dragging && (
        <div className="lopload-drop-overlay pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-kumo-brand/20 ring-2 ring-dashed ring-kumo-brand">
          <p className="lopload-heading text-lg font-semibold text-kumo-default">
            Drop to send
          </p>
        </div>
      )}

      <DragGhost drag={dragMove.drag} ghostRef={dragMove.ghostRef} />

      {moveTargets && (
        <MoveToDialog
          connectionId={connectionId}
          sourceKeys={moveTargets}
          currentPrefix={prefix}
          onClose={() => setMoveTargets(null)}
          onMove={handleMove}
        />
      )}

      {shareEntry && (
        <ShareLinkDialog
          connectionId={connectionId}
          fileKey={shareEntry.key}
          fileName={shareEntry.name}
          onClose={() => setShareEntry(null)}
        />
      )}

      {showTrash && (
        <TrashDialog
          connectionId={connectionId}
          onClose={() => setShowTrash(false)}
          onRestored={() => void refresh()}
        />
      )}
    </div>
  );
}
