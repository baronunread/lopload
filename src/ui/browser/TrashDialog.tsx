import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, Dialog, Empty, useKumoToastManager } from "@cloudflare/kumo";
import { useServices, type TrashItem } from "../services";
import { formatBytes, formatDate } from "../format";
import { SOLID_DANGER_BUTTON_STYLE, SOLID_DANGER_TEXT_STYLE } from "../dangerButton";

export interface TrashDialogProps {
  connectionId: string;
  onClose: () => void;
  /** Called after a successful restore, so the browser can refresh in case
   * the restored item's original path is currently in view. */
  onRestored: () => void;
}

type PendingAction = { kind: "delete-now"; item: TrashItem } | { kind: "empty" };

function displayName(originalKey: string): string {
  const trimmed = originalKey.endsWith("/") ? originalKey.slice(0, -1) : originalKey;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Lists everything currently in the Trash for a connection, with Restore /
 * Delete now per row and an Empty trash action — opened from RemoteBrowser's
 * toolbar. */
export function TrashDialog({ connectionId, onClose, onRestored }: TrashDialogProps) {
  const services = useServices();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const toasts = useKumoToastManager();

  async function refresh() {
    setLoading(true);
    try {
      const result = await services.trash.list(connectionId);
      setItems(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  async function handleRestore(item: TrashItem) {
    setBusyId(item.id);
    try {
      await services.trash.restore(connectionId, item);
      await refresh();
      onRestored();
    } catch (err) {
      toasts.add({
        variant: "error",
        title: "Couldn't restore",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    setConfirming(true);
    try {
      if (pending.kind === "delete-now") {
        await services.trash.deleteNow(connectionId, pending.item);
      } else {
        await services.trash.emptyTrash(connectionId);
      }
      setPending(null);
      await refresh();
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog className="w-full max-w-lg p-6">
          <Dialog.Title>Trash</Dialog.Title>
          <Dialog.Description>
            Items in the Trash are removed permanently after 30 days.
          </Dialog.Description>
          {!loading && items.length === 0 ? (
            <Empty title="Trash is empty" description="Deleted files and folders show up here." />
          ) : (
            <ul className="-mr-2 mt-4 flex max-h-96 flex-col gap-2 overflow-auto pr-2">
              <AnimatePresence initial={false}>
                {items.map((item, index) => (
                  <motion.li
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index * 0.03, 0.15) } }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-center justify-between gap-2 rounded-lg px-4 py-3 ring-1 ring-inset ring-kumo-line"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-kumo-strong">
                        {displayName(item.originalKey)}
                      </div>
                      <div className="mt-1 truncate text-xs text-kumo-subtle">
                        {formatBytes(item.size)} · deleted {formatDate(item.deletedAt)}
                      </div>
                      <div className="truncate text-xs text-kumo-subtle">
                        Gone for good {formatDate(item.purgeAt)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyId === item.id}
                        onClick={() => void handleRestore(item)}
                      >
                        Restore
                      </Button>
                      <Button
                        variant="secondary-destructive"
                        style={SOLID_DANGER_TEXT_STYLE}
                        size="sm"
                        onClick={() => setPending({ kind: "delete-now", item })}
                      >
                        Delete now
                      </Button>
                    </div>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
          <div className="mt-4 flex items-center justify-between">
            <Button
              variant="secondary-destructive"
              style={SOLID_DANGER_TEXT_STYLE}
              disabled={items.length === 0}
              onClick={() => setPending({ kind: "empty" })}
            >
              Empty trash
            </Button>
            <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>Done</Dialog.Close>
          </div>
        </Dialog>
      </Dialog.Root>

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        role="alertdialog"
      >
        {pending && (
          <Dialog className="p-6">
            <Dialog.Title>
              {pending.kind === "empty"
                ? "Empty trash?"
                : `Delete ${displayName(pending.item.originalKey)} now?`}
            </Dialog.Title>
            <Dialog.Description>This can't be undone.</Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                Cancel
              </Dialog.Close>
              <Button
                variant="destructive"
                style={SOLID_DANGER_BUTTON_STYLE}
                loading={confirming}
                onClick={() => void confirmPending()}
              >
                {pending.kind === "empty" ? "Empty trash" : "Delete now"}
              </Button>
            </div>
          </Dialog>
        )}
      </Dialog.Root>
    </>
  );
}
