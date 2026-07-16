import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button, Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { TrashSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useServices, type CopyProgress, type TrashItem } from "../services";
import { formatBytes, formatDate } from "../format";
import { SOLID_DANGER_BUTTON_STYLE, SOLID_DANGER_TEXT_STYLE } from "../dangerButton";

export interface TrashDialogProps {
  connectionId: string;
  onClose: () => void;
  /** Called after a successful restore with the item's original path, so the
   * browser can invalidate that path's cached listing/folder-stats and
   * refresh in case it's currently in view. */
  onRestored: (originalKey: string) => void;
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Per-row "N of M items" readout for a restore or delete-now in flight,
   * fed directly by the service call's onProgress rather than the global
   * move stream — a row only needs its own progress, not everyone else's. */
  const [rowProgress, setRowProgress] = useState<Record<string, CopyProgress>>({});
  /** Running item count for an in-flight Empty trash, shown near its confirm
   * control since there's no per-row spinner for "everything at once". */
  const [emptyProgress, setEmptyProgress] = useState<CopyProgress | null>(null);
  const toasts = useKumoToastManager();

  function setItemProgress(id: string, progress: CopyProgress | undefined): void {
    setRowProgress((prev) => {
      if (progress === undefined) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: progress };
    });
  }

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

  // Restore and delete-now deliberately do NOT remove the row optimistically
  // before the call settles, unlike the bulk/context-menu delete-to-trash
  // flows in RemoteBrowser: those are near-instant, but a big folder restore
  // or purge can run long enough that the row needs to stay put and show
  // "N of M items" while it works — see rowProgress below — rather than
  // vanish immediately and reappear on failure.
  async function handleRestore(item: TrashItem) {
    setBusyId(item.id);
    try {
      await services.trash.restore(connectionId, item, (p) => setItemProgress(item.id, p));
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      onRestored(item.originalKey);
    } catch (err) {
      toasts.add({
        variant: "error",
        title: "Couldn't restore",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    } finally {
      setBusyId(null);
      setItemProgress(item.id, undefined);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    const current = pending;
    setConfirming(true);
    setPending(null);

    if (current.kind === "delete-now") {
      const { item } = current;
      setDeletingId(item.id);
      try {
        await services.trash.deleteNow(connectionId, item, (p) => setItemProgress(item.id, p));
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      } catch (err) {
        toasts.add({
          variant: "error",
          title: "Couldn't delete",
          description: err instanceof Error ? err.message : "Something went wrong.",
        });
      } finally {
        setConfirming(false);
        setDeletingId(null);
        setItemProgress(item.id, undefined);
      }
      return;
    }

    try {
      await services.trash.emptyTrash(connectionId, (p) => setEmptyProgress(p));
      setItems([]);
    } catch (err) {
      toasts.add({
        variant: "error",
        title: "Couldn't empty Trash",
        description: err instanceof Error ? err.message : "Something went wrong.",
      });
    } finally {
      setConfirming(false);
      setEmptyProgress(null);
    }
  }

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog className="w-full sm:w-full max-w-lg p-6">
        <div className="flex items-center gap-3">
            <Dialog.Title className="m-0">Trash</Dialog.Title>
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
          <Dialog.Description>
            Items in the Trash are removed permanently after 30 days.
          </Dialog.Description>
          {!loading && items.length === 0 ? (
            <div className="mt-4 flex flex-col items-center rounded-lg px-6 py-8 text-center ring-1 ring-inset ring-kumo-line">
              <TrashSimpleIcon size={24} className="text-kumo-subtle" aria-hidden />
              <p className="mt-2 text-sm font-medium">Trash is empty</p>
              <p className="mt-0.5 text-sm text-kumo-subtle">
                Deleted files and folders show up here.
              </p>
            </div>
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
                      {rowProgress[item.id] && (
                        <div className="mt-1 truncate text-xs text-kumo-subtle tabular-nums">
                          {busyId === item.id ? "Restoring" : "Deleting"}
                          {"… "}
                          {rowProgress[item.id].copiedItems} of {rowProgress[item.id].totalItems} items
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={busyId === item.id}
                        disabled={deletingId === item.id}
                        onClick={() => void handleRestore(item)}
                      >
                        Restore
                      </Button>
                      <Button
                        variant="secondary-destructive"
                        style={SOLID_DANGER_TEXT_STYLE}
                        size="sm"
                        loading={deletingId === item.id}
                        disabled={busyId === item.id}
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
          <div className="mt-4 flex items-center gap-3">
            {items.length > 0 && (
              <Button
                variant="secondary-destructive"
                style={SOLID_DANGER_TEXT_STYLE}
                loading={emptyProgress !== null}
                onClick={() => setPending({ kind: "empty" })}
              >
                Empty trash
              </Button>
            )}
            {emptyProgress && (
              <span className="text-xs text-kumo-subtle tabular-nums">
                Deleting {emptyProgress.copiedItems} of {emptyProgress.totalItems} items…
              </span>
            )}
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
            <div className="flex items-center gap-3">
              <Dialog.Title className="m-0">
                {pending.kind === "empty"
                  ? "Empty trash?"
                  : `Delete ${displayName(pending.item.originalKey)} now?`}
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
            <Dialog.Description>This can't be undone.</Dialog.Description>
            <div className="mt-4 flex justify-end gap-2">
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
