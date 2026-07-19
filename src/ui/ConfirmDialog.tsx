import { Button, Dialog } from "@cloudflare/kumo";
import { XIcon } from "@phosphor-icons/react";
import { SOLID_DANGER_BUTTON_STYLE } from "./dangerButton";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: () => void;
}

/** The nested alertdialog shell every destructive-action confirm (remove
 * connection, delete/empty trash) reuses: title + Close, description, and a
 * single solid-red confirm button — no separate Cancel, dismissed via the
 * Close button, Escape, or backdrop click. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  loading,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
      <Dialog className="p-6">
        <div className="flex items-center gap-3">
          <Dialog.Title className="m-0">{title}</Dialog.Title>
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
        <Dialog.Description>{description}</Dialog.Description>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="destructive"
            style={SOLID_DANGER_BUTTON_STYLE}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
