import { Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import type { Connection } from "../lib/types";
import { SetupForm } from "./SetupForm";

export interface AddStorageDialogProps {
  /** Connection being edited, if this is opened for an existing entry. */
  existing?: Connection;
  onSaved: (conn: Connection) => void;
  onClose: () => void;
}

export function AddStorageDialog({ existing, onSaved, onClose }: AddStorageDialogProps) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-full max-w-2xl p-6">
        <div className="flex items-center gap-3">
          <Dialog.Title className="m-0">Add a storage connection</Dialog.Title>
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
        <div className="mt-4">
          <SetupForm existing={existing} onSaved={onSaved} />
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
