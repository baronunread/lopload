import { Button, Dialog } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { SetupForm } from "./SetupForm";

export interface AddStorageDialogProps {
  /** Connection being edited, if this is opened for an existing entry. */
  existing?: Connection;
  onSaved: (conn: Connection) => void;
  onClose: () => void;
}

/**
 * Popup for adding (or editing) a storage connection, opened from the
 * header switcher. Cancel lives at the top-left of the header, next to the
 * title, rather than at the bottom of the form.
 */
export function AddStorageDialog({ existing, onSaved, onClose }: AddStorageDialogProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-full max-w-md p-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Dialog.Title className="m-0">Add a storage connection</Dialog.Title>
        </div>
        <div className="mt-4">
          <SetupForm existing={existing} onSaved={onSaved} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
