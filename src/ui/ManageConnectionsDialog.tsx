import { useRef, useState } from "react";
import { Button, Dialog } from "@cloudflare/kumo";
import { TrashIcon, XIcon } from "@phosphor-icons/react";
import type { Connection } from "../lib/types";
import { useServices } from "./services";
import { ConfirmDialog } from "./ConfirmDialog";
import { SOLID_DANGER_TEXT_STYLE } from "./dangerButton";

export interface ManageConnectionsDialogProps {
  connections: Connection[];
  onClose: () => void;
  onDeleted: (id: string) => void;
}

/**
 * Lists every saved storage connection with a per-row remove action.
 * Reuses the same confirm-before-destructive-action pattern as deleting a
 * file/folder in RemoteBrowser (a nested alertdialog, not a bare click).
 */
export function ManageConnectionsDialog({
  connections,
  onClose,
  onDeleted,
}: ManageConnectionsDialogProps) {
  const services = useServices();
  const [pending, setPending] = useState<Connection | null>(null);
  const [deleting, setDeleting] = useState(false);

  const lastPendingRef = useRef<Connection | null>(null);
  if (pending) lastPendingRef.current = pending;
  const dialogPending = pending ?? lastPendingRef.current;

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true);
    try {
      await services.connections.delete(pending.id);
      onDeleted(pending.id);
      setPending(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog className="w-full sm:w-full max-w-md p-6">
          <div className="flex items-center gap-3">
            <Dialog.Title className="m-0">Storage connections</Dialog.Title>
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
          {connections.length === 0 ? (
            <p className="mt-2 text-sm text-kumo-subtle">No storage connections yet.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-1">
              {connections.map((conn) => (
                <li
                  key={conn.id}
                  className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 ring-1 ring-kumo-line"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-kumo-strong">{conn.name}</div>
                    <div className="truncate text-xs text-kumo-subtle">{conn.endpoint}</div>
                  </div>
                  <Button
                    variant="secondary-destructive"
                    style={SOLID_DANGER_TEXT_STYLE}
                    icon={TrashIcon}
                    aria-label={`Remove ${conn.name}`}
                    onClick={() => setPending(conn)}
                  />
                </li>
              ))}
            </ul>
          )}

        </Dialog>
      </Dialog.Root>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={`Remove ${dialogPending?.name ?? "this connection"}?`}
        description="This only removes the connection from Lopload - nothing in your storage is deleted. You can add it again later with the same details."
        confirmLabel="Remove"
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
