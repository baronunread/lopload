import { Button, Input } from "@cloudflare/kumo";
import { FolderPlusIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";

export interface RemoteBrowserToolbarProps {
  filterQuery: string;
  onFilterChange: (query: string) => void;
  onNewFolder: () => void;
  onShowTrash: () => void;
  onUpload: () => void;
}

/** The filter box plus New folder/Trash/Upload actions, next to the
 * breadcrumb trail. */
export function RemoteBrowserToolbar({
  filterQuery,
  onFilterChange,
  onNewFolder,
  onShowTrash,
  onUpload,
}: RemoteBrowserToolbarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Input
        size="sm"
        placeholder="Filter"
        aria-label="Filter this folder"
        value={filterQuery}
        onChange={(e) => onFilterChange(e.target.value)}
        className="w-36"
        onClick={(e) => e.stopPropagation()}
      />
      <Button variant="secondary" size="sm" icon={FolderPlusIcon} onClick={onNewFolder}>
        New folder
      </Button>
      <Button variant="secondary" size="sm" icon={TrashIcon} onClick={onShowTrash}>
        Trash
      </Button>
      <Button variant="primary" size="sm" icon={UploadSimpleIcon} onClick={onUpload}>
        Upload
      </Button>
    </div>
  );
}
