import { FileIcon, FilesIcon, FolderIcon } from "@phosphor-icons/react";
import type { DragChipRefs } from "./useDragMove";

export interface DragGhostProps {
  refs: DragChipRefs;
}

/** Custom drag image for row moves: a small chip (icon + name, or a count
 * when dragging multiple selected rows) centered under the cursor, instead
 * of the browser's default of the whole (huge) row. Parked off-screen while
 * idle; showDragChip moves it under the cursor for the duration of the
 * drag-image snapshot, because WebKit only rasterizes elements that are
 * actually painted (a detached or off-screen node yields the OS's generic
 * rectangle). */
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
      <img
        ref={refs.thumbRef}
        alt=""
        style={{ display: "none" }}
        className="lopload-media-outline h-6 w-6 shrink-0 rounded object-cover"
      />
      <span ref={refs.labelRef} className="lopload-body truncate text-sm" />
    </div>
  );
}
