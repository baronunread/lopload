import { Button, Table } from "@cloudflare/kumo";
import { DotsThreeVerticalIcon } from "@phosphor-icons/react";
import type { DragEvent, MouseEvent as ReactMouseEvent } from "react";
import type { RemoteEntry } from "../../lib/types";
import { formatBytes, formatDate } from "../format";
import { Thumbnail } from "../Thumbnail";

export interface RemoteBrowserRowProps {
  entry: RemoteEntry;
  connectionId: string;
  isSelected: boolean;
  isDropTarget: boolean;
  /** Only present for folder rows — spread onto the <tr> to accept drops. */
  dropTargetHandlers?: {
    onDragOver: (e: DragEvent) => void;
    onDragEnter: (e: DragEvent) => void;
    onDragLeave: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
  };
  onClick: (e: ReactMouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
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
  dropTargetHandlers,
  onClick,
  onDragStart,
  onDragEnd,
  onDoubleClick,
  onContextMenu,
  onActionsClick,
  style,
}: RemoteBrowserRowProps) {
  return (
    <Table.Row
      style={style}
      className={`h-14 cursor-default select-none ${
        isDropTarget
          ? "bg-kumo-tint ring-1 ring-inset ring-kumo-brand"
          : isSelected
            ? "bg-kumo-brand/10 ring-1 ring-inset ring-kumo-brand/50 hover:bg-kumo-brand/15"
            : "hover:bg-kumo-tint"
      }`}
      draggable
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      {...dropTargetHandlers}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <Table.Cell className="flex min-w-0 items-center gap-2 p-2 sm:p-3">
        <Thumbnail
          connectionId={connectionId}
          entryKey={entry.key}
          name={entry.name}
          kind={entry.kind}
        />
        <span className="lopload-body cursor-default truncate select-none">{entry.name}</span>
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
          onClick={onActionsClick}
        />
      </Table.Cell>
    </Table.Row>
  );
}
