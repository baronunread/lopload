import { Button, Table } from "@cloudflare/kumo";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { RemoteEntry } from "../../lib/types";
import type { FolderInfo } from "../services";
import { formatBytes, formatDate } from "../format";
import { Thumbnail } from "../Thumbnail";

export interface RemoteBrowserRowProps {
  entry: RemoteEntry;
  connectionId: string;
  isSelected: boolean;
  isDropTarget: boolean;
  /** True when this row is the target of the currently-open context menu
   * (right-click or the "⋯" trigger) — it keeps the selected-style
   * highlight for as long as the menu stays open, even though the pointer
   * has moved off the row onto the menu itself. */
  isMenuTarget: boolean;
  /** True whenever any context menu is open (including the background,
   * entry-less menu) — suppresses every row's hover highlight so the
   * pointer moving over other rows to reach the menu doesn't light them
   * up. */
  suppressHover: boolean;
  /** Lazily computed size/modified stats for folder rows (S3 folders carry
   * no metadata of their own); undefined while still loading. */
  folderMeta?: FolderInfo;
  /** Only present for folder rows — spread onto the <tr> so hovering it
   * during a drag marks it as the drop target. */
  dropTargetHandlers?: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
  onClick: (e: ReactMouseEvent) => void;
  onMouseDown: (e: ReactMouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onActionsClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  style?: React.CSSProperties;
}

/** A single row in the remote listing table — thumbnail, name, size,
 * modified date, and the "⋯" actions trigger. Purely presentational: all
 * selection/drag/menu behavior is wired up by the caller. */
export function RemoteBrowserRow({
  entry,
  connectionId,
  isSelected,
  isDropTarget,
  isMenuTarget,
  suppressHover,
  folderMeta,
  dropTargetHandlers,
  onClick,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
  onActionsClick,
  style,
}: RemoteBrowserRowProps) {
  const isFolder = entry.kind === "folder";
  const size = isFolder ? folderMeta?.totalSize : entry.size;
  const lastModified = isFolder ? (folderMeta?.lastModified ?? undefined) : entry.lastModified;
  return (
    <Table.Row
      style={style}
      className={`h-14 cursor-default select-none ${
        isDropTarget
          ? "bg-kumo-tint ring-1 ring-inset ring-kumo-brand"
          : isSelected || isMenuTarget
            ? "bg-kumo-brand/10 ring-1 ring-inset ring-kumo-brand/50 hover:bg-kumo-brand/15"
            : suppressHover
              ? ""
              : "hover:bg-kumo-tint"
      }`}
      onClick={onClick}
      onMouseDown={onMouseDown}
      {...dropTargetHandlers}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <Table.Cell className="min-w-0 p-2 sm:p-3">
        <div className="flex min-w-0 items-center gap-2">
          <Thumbnail
            connectionId={connectionId}
            entryKey={entry.key}
            name={entry.name}
            kind={entry.kind}
          />
          <span className="lopload-body cursor-default truncate select-none">{entry.name}</span>
        </div>
      </Table.Cell>
      <Table.Cell className="lopload-body whitespace-nowrap p-2 text-kumo-subtle tabular-nums sm:p-3">
        {size !== undefined ? formatBytes(size) : "—"}
      </Table.Cell>
      <Table.Cell className="hidden whitespace-nowrap p-2 lopload-body text-kumo-subtle tabular-nums sm:table-cell sm:p-3">
        {lastModified !== undefined ? formatDate(lastModified) : "—"}
      </Table.Cell>
      <Table.Cell className="p-1 text-right sm:p-2">
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          aria-label={`Actions for ${entry.name}`}
          icon={DotsThreeVerticalIcon}
          onClick={onActionsClick}
        />
      </Table.Cell>
    </Table.Row>
  );
}
