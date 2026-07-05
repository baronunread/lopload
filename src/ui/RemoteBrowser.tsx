import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  Breadcrumbs,
  Button,
  Dialog,
  Empty,
  Input,
  Table,
  useKumoToastManager,
} from "@cloudflare/kumo";
import {
  DotsThreeVerticalIcon,
  FileIcon,
  FilesIcon,
  FolderIcon,
  FolderPlusIcon,
  HouseIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import type { RemoteEntry } from "../lib/types";
import { useServices, type FolderInfo } from "./services";
import { formatBytes, formatDate, segmentsForPrefix } from "./format";
import { Thumbnail } from "./Thumbnail";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

export interface RemoteBrowserProps {
  connectionId: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}

type PendingAction =
  | { kind: "new-folder" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "delete"; entry: RemoteEntry }
  | { kind: "bulk-delete"; entries: RemoteEntry[] };

type FolderInfoState = { status: "loading" } | ({ status: "loaded" } & FolderInfo);

/** How long to wait, after the last relevant engine event, before re-listing
 * the current folder — batches of many files each finishing individually
 * would otherwise trigger a re-list per file. */
const REFRESH_DEBOUNCE_MS = 500;

/** Custom drag MIME type for internal row drag-to-move. Kept distinct from
 * the browser's native "Files" drag type (used for OS file drops, which are
 * actually handled separately via the Tauri onDragDropEvent bridge) so a
 * move-drag can never be mistaken for an incoming file upload. */
const MOVE_DRAG_TYPE = "application/x-lopload-key";

/** Remote folder browser: breadcrumbs, listing table, thumbnails, and a right-click menu. */
export function RemoteBrowser({ connectionId, prefix, onNavigate }: RemoteBrowserProps) {
  const services = useServices();
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: RemoteEntry } | null>(
    null,
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [infoEntry, setInfoEntry] = useState<RemoteEntry | null>(null);
  const [folderInfoState, setFolderInfoState] = useState<FolderInfoState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClickedKey = useRef<string | null>(null);
  const dragCounter = useRef(0);
  const toasts = useKumoToastManager();

  const dragChipRef = useRef<HTMLDivElement>(null);
  const dragChipLabelRef = useRef<HTMLSpanElement>(null);
  const dragChipFolderIconRef = useRef<HTMLSpanElement>(null);
  const dragChipFileIconRef = useRef<HTMLSpanElement>(null);
  const dragChipFilesIconRef = useRef<HTMLSpanElement>(null);

  async function refresh() {
    setLoading(true);
    try {
      const result = await services.browser.list(connectionId, prefix);
      setEntries(result);
      setLoadFailed(false);
    } catch {
      // e.g. missing keychain credentials or an unreachable endpoint —
      // surface a retryable error state instead of an unhandled rejection.
      setEntries([]);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    setSelected(new Set());
    lastClickedKey.current = null;
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

  // Escape clears the current multi-selection, wherever focus happens to be.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(new Set());
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

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

  function navigate(next: string) {
    onNavigate(next);
    void services.connections.setLastPrefix(connectionId, next);
  }

  /** Moves `fromKey` (a row's full path) to live under `toPrefix` instead,
   * keeping its own name. */
  async function moveOne(fromKey: string, toPrefix: string): Promise<void> {
    if (!fromKey || fromKey === toPrefix) return;
    const name = entries.find((e) => e.key === fromKey)?.name;
    if (!name) return;
    const toKey = `${toPrefix}${name}`;
    if (toKey === fromKey) return;
    await services.browser.move(connectionId, fromKey, toKey);
  }

  /** Moves every dragged key to live under `toPrefix` — a single row, or the
   * whole selection when dragging one of several selected rows. */
  async function handleMove(fromKeys: string[], toPrefix: string) {
    await Promise.all(fromKeys.map((key) => moveOne(key, toPrefix)));
    await refresh();
  }

  /** Parses the payload written to the custom drag MIME type: a JSON array
   * of the keys being moved (one, or the whole selection). */
  function parseDragKeys(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // Fall through — treat the raw string as a single legacy key.
    }
    return raw ? [raw] : [];
  }

  /** Renders the compact "chip" used as the custom drag image (a small
   * preview centered under the cursor) instead of the browser's default,
   * which would otherwise drag the whole (huge) row or its text. */
  function showDragChip(e: DragEvent, label: string, variant: "folder" | "file" | "files") {
    const chip = dragChipRef.current;
    const labelEl = dragChipLabelRef.current;
    if (!chip || !labelEl) return;
    const iconRefs = [
      ["folder", dragChipFolderIconRef],
      ["file", dragChipFileIconRef],
      ["files", dragChipFilesIconRef],
    ] as const;
    labelEl.textContent = label;
    for (const [key, ref] of iconRefs) {
      if (ref.current) ref.current.style.display = key === variant ? "" : "none";
    }
    try {
      // Test environments (happy-dom/jsdom) either omit this or throw —
      // the custom drag image is a visual nicety only, never load-bearing.
      e.dataTransfer.setDragImage?.(chip, 20, 20);
    } catch {
      // ignored
    } finally {
      // The browser rasterizes the drag image synchronously inside
      // setDragImage, so it's safe to blank the (permanently off-screen)
      // chip right back out — otherwise its text would be a second,
      // always-present copy of every row's name in the DOM.
      labelEl.textContent = "";
      for (const [, ref] of iconRefs) {
        if (ref.current) ref.current.style.display = "none";
      }
    }
  }

  /** Drag handlers for a valid drop target (a folder row, or an ancestor
   * breadcrumb) that only react to internal row drags, never OS file drags. */
  function dropTargetHandlers(toPrefix: string) {
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
      },
      onDragEnter: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(toPrefix);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.stopPropagation();
        setDropTarget((current) => (current === toPrefix ? null : current));
      },
      onDrop: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(null);
        const fromKeys = parseDragKeys(e.dataTransfer.getData(MOVE_DRAG_TYPE));
        void handleMove(fromKeys, toPrefix);
      },
    };
  }

  const folders = entries.filter((e) => e.kind === "folder");
  const files = entries.filter((e) => e.kind === "file");
  const rows = [...folders, ...files];
  const segments = segmentsForPrefix(prefix);

  function contextItemsFor(entry?: RemoteEntry): ContextMenuItem[] {
    // Right-clicking a row that's part of a multi-row selection offers bulk
    // actions on the whole selection instead of the usual single-entry menu.
    if (entry && selected.has(entry.key) && selected.size > 1) {
      const selectedEntries = rows.filter((r) => selected.has(r.key));
      return [
        {
          label: `Delete ${selectedEntries.length} items`,
          danger: true,
          onSelect: () => setPending({ kind: "bulk-delete", entries: selectedEntries }),
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
          label: "Copy link",
          onSelect: () => {
            void services.browser.copyLink(connectionId, entry.key).then((link) => {
              void navigator.clipboard?.writeText(link);
            });
          },
        },
        {
          label: entry.kind === "folder" ? "Folder info" : "File info",
          onSelect: () => setInfoEntry(entry),
        },
      );
      items.push({
        label: "Delete",
        danger: true,
        onSelect: () => setPending({ kind: "delete", entry }),
      });
    }
    return items;
  }

  /** Click-to-select: plain click selects only this row, cmd/ctrl-click
   * toggles it in/out of the selection, and shift-click extends the
   * selection to every row between the last-clicked row and this one. */
  function handleRowClick(entry: RemoteEntry, e: ReactMouseEvent) {
    if (e.shiftKey && lastClickedKey.current) {
      const startIdx = rows.findIndex((r) => r.key === lastClickedKey.current);
      const endIdx = rows.findIndex((r) => r.key === entry.key);
      if (startIdx !== -1 && endIdx !== -1) {
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        setSelected(new Set(rows.slice(from, to + 1).map((r) => r.key)));
      }
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.key)) next.delete(entry.key);
        else next.add(entry.key);
        return next;
      });
      lastClickedKey.current = entry.key;
      return;
    }
    setSelected(new Set([entry.key]));
    lastClickedKey.current = entry.key;
  }

  async function confirmPending() {
    if (!pending) return;
    if (pending.kind === "new-folder") {
      await services.browser.createFolder(connectionId, prefix, pendingName);
    } else if (pending.kind === "rename") {
      await services.browser.rename(connectionId, pending.entry.key, pendingName);
    } else if (pending.kind === "delete") {
      await services.browser.delete(connectionId, pending.entry.key);
    } else if (pending.kind === "bulk-delete") {
      await Promise.all(
        pending.entries.map((entry) => services.browser.delete(connectionId, entry.key)),
      );
      setSelected(new Set());
    }
    setPending(null);
    await refresh();
  }

  return (
    <div
      className="relative flex h-full flex-col gap-3"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
        dragCounter.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(MOVE_DRAG_TYPE)) return;
        e.preventDefault();
      }}
      onClick={() => setSelected(new Set())}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Breadcrumbs>
          <span
            className={`contents ${dropTarget === "" ? "rounded bg-kumo-tint" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              navigate("");
            }}
            {...dropTargetHandlers("")}
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
                    className={`contents ${dropTarget === segPrefix ? "rounded bg-kumo-tint" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(segPrefix);
                    }}
                    {...dropTargetHandlers(segPrefix)}
                  >
                    <Breadcrumbs.Link href="#">{segment}</Breadcrumbs.Link>
                  </span>
                )}
              </span>
            );
          })}
        </Breadcrumbs>
        <div className="flex items-center gap-2">
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

      {loadFailed ? (
        <Empty
          title="Couldn't load this storage"
          description="Check the connection's details and credentials, then try again."
          contents={
            <Button variant="secondary" onClick={() => void refresh()}>
              Try again
            </Button>
          }
        />
      ) : !loading && rows.length === 0 ? (
        <Empty title="This folder is empty" description="Drag files in, or use Upload." />
      ) : (
        <Table layout="fixed" className="[&_td]:border-b-0">
          <Table.Header>
            <Table.Row>
              <Table.Head className="w-auto p-2 sm:p-3">Name</Table.Head>
              <Table.Head className="w-16 p-2 sm:w-24 sm:p-3">Size</Table.Head>
              <Table.Head className="hidden w-32 p-2 sm:table-cell sm:p-3">Modified</Table.Head>
              <Table.Head className="w-9 p-2 sm:w-12 sm:p-3">
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body className="divide-y divide-kumo-line">
            {rows.map((entry) => {
              const isFolder = entry.kind === "folder";
              const isDropTarget = isFolder && dropTarget === entry.key;
              const isSelected = selected.has(entry.key);
              return (
                <Table.Row
                  key={entry.key}
                  className={`h-14 cursor-default select-none ${
                    isDropTarget
                      ? "bg-kumo-tint ring-1 ring-inset ring-kumo-brand"
                      : isSelected
                        ? "bg-kumo-brand/10 ring-1 ring-inset ring-kumo-brand/50 hover:bg-kumo-brand/15"
                        : "hover:bg-kumo-tint"
                  }`}
                  draggable
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRowClick(entry, e);
                  }}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    const isMultiDrag = isSelected && selected.size > 1;
                    const dragKeys = isMultiDrag ? Array.from(selected) : [entry.key];
                    if (!isMultiDrag) {
                      setSelected(new Set([entry.key]));
                      lastClickedKey.current = entry.key;
                    }
                    e.dataTransfer.setData(MOVE_DRAG_TYPE, JSON.stringify(dragKeys));
                    e.dataTransfer.effectAllowed = "move";
                    const label =
                      dragKeys.length > 1 ? `${dragKeys.length} items` : entry.name;
                    showDragChip(e, label, dragKeys.length > 1 ? "files" : isFolder ? "folder" : "file");
                  }}
                  onDragEnd={() => setDropTarget(null)}
                  {...(isFolder ? dropTargetHandlers(entry.key) : {})}
                  onDoubleClick={() => {
                    if (isFolder) navigate(entry.key);
                    else setInfoEntry(entry);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setMenu({ x: e.clientX, y: e.clientY, entry });
                  }}
                >
                  <Table.Cell className="flex min-w-0 items-center gap-2 p-2 sm:p-3">
                    <Thumbnail
                      connectionId={connectionId}
                      entryKey={entry.key}
                      name={entry.name}
                      kind={entry.kind}
                    />
                    <span className="lopload-body cursor-default truncate select-none">
                      {entry.name}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="lopload-body whitespace-nowrap p-2 text-kumo-subtle sm:p-3">
                    {entry.kind === "file" ? formatBytes(entry.size ?? 0) : "—"}
                  </Table.Cell>
                  <Table.Cell className="hidden whitespace-nowrap p-2 lopload-body text-kumo-subtle sm:table-cell sm:p-3">
                    {formatDate(entry.lastModified)}
                  </Table.Cell>
                  <Table.Cell className="p-1 text-right sm:p-2">
                    <Button
                      variant="ghost"
                      shape="square"
                      size="sm"
                      aria-label={`Actions for ${entry.name}`}
                      icon={DotsThreeVerticalIcon}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenu({ x: rect.left, y: rect.bottom, entry });
                      }}
                    />
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
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
        role={pending?.kind === "delete" || pending?.kind === "bulk-delete" ? "alertdialog" : "dialog"}
      >
        {pending && (
          <Dialog className="p-6">
            {pending.kind === "delete" ? (
              <>
                <Dialog.Title>Delete {pending.entry.name}?</Dialog.Title>
                <Dialog.Description>This can't be undone.</Dialog.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                    Cancel
                  </Dialog.Close>
                  <Button variant="destructive" onClick={() => void confirmPending()}>
                    Delete
                  </Button>
                </div>
              </>
            ) : pending.kind === "bulk-delete" ? (
              <>
                <Dialog.Title>Delete {pending.entries.length} items?</Dialog.Title>
                <Dialog.Description>This can't be undone.</Dialog.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                    Cancel
                  </Dialog.Close>
                  <Button variant="destructive" onClick={() => void confirmPending()}>
                    Delete
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Dialog.Title>
                  {pending.kind === "new-folder" ? "New folder" : "Rename"}
                </Dialog.Title>
                <Input
                  label="Name"
                  value={pendingName}
                  onChange={(e) => setPendingName(e.target.value)}
                  autoFocus
                />
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                    Cancel
                  </Dialog.Close>
                  <Button
                    variant="primary"
                    disabled={!pendingName.trim()}
                    onClick={() => void confirmPending()}
                  >
                    Save
                  </Button>
                </div>
              </>
            )}
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
            <Dialog.Title>
              {infoEntry.kind === "folder" ? "Folder info" : "File info"} (debug placeholder)
            </Dialog.Title>
            <Dialog.Description>
              Raw listing data, shown as-is — a real detail view will replace this.
            </Dialog.Description>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
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
            <div className="mt-4 flex justify-end">
              <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                Close
              </Dialog.Close>
            </div>
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

      {/* Custom drag image for row moves: a small chip (icon + name, or a
          count when dragging multiple selected rows) centered under the
          cursor, instead of the browser's default of the whole (huge) row.
          Rendered off-screen — setDragImage needs a laid-out element to
          rasterize, so this can't be a detached node. */}
      <div
        ref={dragChipRef}
        aria-hidden
        className="pointer-events-none fixed -top-[1000px] -left-[1000px] flex max-w-48 items-center gap-2 rounded-lg bg-kumo-base px-3 py-2 shadow-lg ring-1 ring-kumo-line"
      >
        <span ref={dragChipFolderIconRef} style={{ display: "none" }}>
          <FolderIcon size={18} weight="fill" className="shrink-0 text-kumo-brand" />
        </span>
        <span ref={dragChipFileIconRef} style={{ display: "none" }}>
          <FileIcon size={18} className="shrink-0 text-kumo-subtle" />
        </span>
        <span ref={dragChipFilesIconRef} style={{ display: "none" }}>
          <FilesIcon size={18} className="shrink-0 text-kumo-subtle" />
        </span>
        <span ref={dragChipLabelRef} className="lopload-body truncate text-sm" />
      </div>
    </div>
  );
}
