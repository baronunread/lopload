import { FileIcon, FilesIcon, FolderIcon } from "@phosphor-icons/react";
import { iconForFileName } from "../fileIcons";
import type { ActiveDrag } from "./useDragMove";

export interface DragGhostProps {
  drag: ActiveDrag | null;
  ghostRef: React.RefObject<HTMLDivElement | null>;
}

/** The chip that follows the cursor during a drag-to-move: the dragged
 * file's thumbnail (or a type icon, or a count when dragging several rows)
 * plus its name. A live element positioned by useDragMove — not a
 * setDragImage snapshot, which WebKit renders as a generic rectangle. */
export function DragGhost({ drag, ghostRef }: DragGhostProps) {
  if (!drag) return null;
  // Single-file drags without a rendered thumbnail (non-image/video types)
  // fall back to a per-file-type icon rather than the generic file glyph.
  const TypeIcon = drag.fileName !== undefined ? iconForFileName(drag.fileName) : FileIcon;
  return (
    <div
      ref={ghostRef}
      aria-hidden
      style={{ left: drag.x, top: drag.y }}
      className="lopload-pop-in pointer-events-none fixed z-50 flex max-w-48 items-center gap-2 rounded-full bg-kumo-elevated py-1.5 pl-2 pr-3 shadow-lg ring-1 ring-kumo-line"
    >
      {drag.thumbnailSrc !== undefined ? (
        <img
          src={drag.thumbnailSrc}
          alt=""
          className="lopload-media-outline h-6 w-6 shrink-0 rounded-full object-cover"
        />
      ) : drag.variant === "folder" ? (
        <FolderIcon size={18} weight="fill" className="shrink-0 text-kumo-brand" />
      ) : drag.variant === "files" ? (
        <FilesIcon size={18} className="shrink-0 text-kumo-subtle" />
      ) : (
        <TypeIcon size={18} className="shrink-0 text-kumo-subtle" />
      )}
      <span className="lopload-body truncate text-sm">{drag.label}</span>
    </div>
  );
}
