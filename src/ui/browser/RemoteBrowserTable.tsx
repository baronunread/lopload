import { Table } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RemoteEntry } from "../../lib/types";
import type { FolderInfo } from "../services";
import { RemoteBrowserRow } from "./RemoteBrowserRow";
import type { SortKey, SortState } from "./sort";

const ROW_HEIGHT = 56;

export interface RemoteBrowserTableProps {
  rows: RemoteEntry[];
  connectionId: string;
  selected: Set<string>;
  dropTarget: string | null;
  /** The key of the row the currently-open context menu targets, or null
   * when no menu is open or it's the background (entry-less) menu. */
  menuTargetKey: string | null;
  /** Whether any context menu is currently open — including the
   * background/entry-less one, which has no `menuTargetKey`. Used to
   * suppress hover highlighting on every row while it's up. */
  menuOpen: boolean;
  /** Lazily computed per-folder stats, keyed by folder key. */
  folderMeta: Record<string, FolderInfo>;
  dropTargetHandlersFor: (entry: RemoteEntry) =>
    | {
        onMouseEnter: () => void;
        onMouseLeave: () => void;
      }
    | undefined;
  onRowClick: (entry: RemoteEntry, e: ReactMouseEvent) => void;
  onRowMouseDown: (entry: RemoteEntry, e: ReactMouseEvent) => void;
  onRowDoubleClick: (entry: RemoteEntry) => void;
  onRowContextMenu: (entry: RemoteEntry, e: ReactMouseEvent) => void;
  onRowActionsClick: (entry: RemoteEntry, e: ReactMouseEvent<HTMLButtonElement>) => void;
  sort: SortState;
  onSortChange: (key: SortKey) => void;
}

function SortableHead({
  label,
  sortKey,
  sort,
  onSortChange,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSortChange: (key: SortKey) => void;
  className: string;
}) {
  const isActive = sort.key === sortKey;
  return (
    <Table.Head
      className={className}
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="lopload-body flex items-center gap-1 text-left font-medium"
        onClick={() => onSortChange(sortKey)}
      >
        {label}
        {isActive &&
          (sort.direction === "asc" ? (
            <CaretUpIcon size={12} weight="bold" />
          ) : (
            <CaretDownIcon size={12} weight="bold" />
          ))}
      </button>
    </Table.Head>
  );
}

/** The remote listing table: sortable headers and a virtualized, scrollable
 * body so folders with thousands of entries stay smooth. Selection,
 * drag-move, and context menus are all wired up by the caller and passed
 * down per-row. */
export function RemoteBrowserTable({
  rows,
  connectionId,
  selected,
  dropTarget,
  menuTargetKey,
  menuOpen,
  folderMeta,
  dropTargetHandlersFor,
  onRowClick,
  onRowMouseDown,
  onRowDoubleClick,
  onRowContextMenu,
  onRowActionsClick,
  sort,
  onSortChange,
}: RemoteBrowserTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <Table layout="fixed" className="[&_td]:border-b-0">
        <Table.Header sticky>
          <Table.Row>
            <SortableHead
              label="Name"
              sortKey="name"
              sort={sort}
              onSortChange={onSortChange}
              className="w-auto p-2 sm:p-3"
            />
            <SortableHead
              label="Size"
              sortKey="size"
              sort={sort}
              onSortChange={onSortChange}
              className="w-16 p-2 sm:w-24 sm:p-3"
            />
            <SortableHead
              label="Modified"
              sortKey="modified"
              sort={sort}
              onSortChange={onSortChange}
              className="hidden w-32 p-2 sm:table-cell sm:p-3"
            />
            <Table.Head className="w-9 p-2 sm:w-12 sm:p-3">
              <span className="sr-only">Actions</span>
            </Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body className="divide-y divide-kumo-line">
          {paddingTop > 0 && (
            <tr aria-hidden style={{ height: paddingTop }}>
              <td colSpan={4} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
          {virtualItems.map((virtualRow) => {
            const entry = rows[virtualRow.index];
            const isFolder = entry.kind === "folder";
            return (
              <RemoteBrowserRow
                key={entry.key}
                entry={entry}
                connectionId={connectionId}
                isSelected={selected.has(entry.key)}
                isDropTarget={isFolder && dropTarget === entry.key}
                isMenuTarget={menuOpen && menuTargetKey === entry.key}
                suppressHover={menuOpen}
                folderMeta={isFolder ? folderMeta[entry.key] : undefined}
                dropTargetHandlers={dropTargetHandlersFor(entry)}
                onClick={(e) => onRowClick(entry, e)}
                onMouseDown={(e) => onRowMouseDown(entry, e)}
                onDoubleClick={() => onRowDoubleClick(entry)}
                onContextMenu={(e) => onRowContextMenu(entry, e)}
                onActionsClick={(e) => onRowActionsClick(entry, e)}
              />
            );
          })}
          {paddingBottom > 0 && (
            <tr aria-hidden style={{ height: paddingBottom }}>
              <td colSpan={4} style={{ padding: 0, border: 0 }} />
            </tr>
          )}
        </Table.Body>
      </Table>
    </div>
  );
}
