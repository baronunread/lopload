import { Button, Dialog, Input } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { RemoteEntry } from "../../lib/types";
import type { FolderInfo } from "../services";
import { formatBytes, formatDate } from "../format";

export type PendingAction = { kind: "new-folder" } | { kind: "rename"; entry: RemoteEntry };

export type FolderInfoState = { status: "loading" } | ({ status: "loaded" } & FolderInfo);

export interface PendingActionDialogProps {
  pending: PendingAction | null;
  pendingName: string;
  onNameChange: (name: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}

/** The "New folder" / "Rename" dialog — a single name field, shared by both
 * actions since they only differ in title and what confirming does. */
export function PendingActionDialog({
  pending,
  pendingName,
  onNameChange,
  onConfirm,
  onClose,
}: PendingActionDialogProps) {
  return (
    <Dialog.Root open={pending !== null} onOpenChange={(open) => !open && onClose()}>
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
          <Input label="Name" value={pendingName} onChange={(e) => onNameChange(e.target.value)} autoFocus />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="primary" disabled={!pendingName.trim()} onClick={onConfirm}>
              Save
            </Button>
          </div>
        </Dialog>
      )}
    </Dialog.Root>
  );
}

export interface EntryInfoDialogProps {
  infoEntry: RemoteEntry | null;
  folderInfoState: FolderInfoState | null;
  onClose: () => void;
}

/** The "File info" / "Folder info" dialog: name, path, type, and either the
 * file's own size/modified date or (for folders, computed on demand since
 * S3 "folders" carry no metadata of their own) a recursive file count and
 * total size. */
export function EntryInfoDialog({ infoEntry, folderInfoState, onClose }: EntryInfoDialogProps) {
  return (
    <Dialog.Root open={infoEntry !== null} onOpenChange={(open) => !open && onClose()}>
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
  );
}
