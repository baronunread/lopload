import { FileIcon, FilesIcon, FolderIcon } from "@phosphor-icons/react";
import type { DragChipRefs } from "./useDragMove";

export interface DragGhostProps {
  refs: DragChipRefs;
}

/** Custom drag image for row moves: a small chip (icon + name, or a count
 * when dragging multiple selected rows) centered under the cursor, instead
 * of the browser's default of the whole (huge) row. Rendered off-screen —
 * setDragImage needs a laid-out element to rasterize, so this can't be a
 * detached node. */
export function DragGhost({ refs }: DragGhostProps) {
  return (
    <div
      ref={refs.chipRef}
      aria-hidden
      className="pointer-events-none fixed -top-[1000px] -left-[1000px] flex max-w-48 items-center gap-2 rounded-lg bg-kumo-base px-3 py-2 shadow-lg ring-1 ring-kumo-line"
    >
      <span ref={refs.folderIconRef} style={{ display: "none" }}>
        <FolderIcon size={18} weight="fill" className="shrink-0 text-kumo-brand" />
      </span>
      <span ref={refs.fileIconRef} style={{ display: "none" }}>
        <FileIcon size={18} className="shrink-0 text-kumo-subtle" />
      </span>
      <span ref={refs.filesIconRef} style={{ display: "none" }}>
        <FilesIcon size={18} className="shrink-0 text-kumo-subtle" />
      </span>
      <span ref={refs.labelRef} className="lopload-body truncate text-sm" />
    </div>
  );
}
