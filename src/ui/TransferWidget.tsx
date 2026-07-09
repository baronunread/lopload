import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CaretDownIcon, FolderIcon, FolderOpenIcon, StopCircleIcon, XIcon } from "@phosphor-icons/react";
import type { EngineEvent, Transfer, TransferState } from "../lib/types";
import { useServices } from "./services";
import { StatusChip } from "./StatusChip";
import { formatBytes, formatSpeed } from "./format";

/** One widget row: either a single file, or every file from the same
 * dropped/picked folder (`folderId`) collapsed into one aggregated row. */
interface DisplayRow {
  rowKey: string;
  folderName?: string;
  transfers: Transfer[];
}

/** Groups transfers that share a `folderId` into one row, preserving the
 * order each row (folder or lone file) first appeared in. */
function groupTransfers(list: Transfer[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  const indexByFolder = new Map<string, number>();
  for (const t of list) {
    if (t.folderId) {
      const idx = indexByFolder.get(t.folderId);
      if (idx !== undefined) {
        rows[idx].transfers.push(t);
        continue;
      }
      indexByFolder.set(t.folderId, rows.length);
      rows.push({ rowKey: t.folderId, folderName: t.folderName, transfers: [t] });
    } else {
      rows.push({ rowKey: t.id, transfers: [t] });
    }
  }
  return rows;
}

/** Synthesizes one representative state for a row so it can reuse
 * StatusChip's rendering: in-flight while anything in the row still is,
 * otherwise failed if anything failed, otherwise done. Percent is
 * byte-based: bytesDone / totalBytes across all transfers in the row. */
function rowState(transfers: Transfer[]): TransferState {
  const totalBytes = transfers.reduce((sum, t) => sum + t.size, 0);
  const doneBytes = transfers.reduce((sum, t) => {
    if (t.state.kind === "uploaded" || t.state.kind === "downloaded") return sum + t.size;
    if (t.state.kind === "sending") return sum + t.size * (t.state.percent / 100);
    return sum;
  }, 0);
  const failed = transfers.filter((t) => t.state.kind === "failed");
  const inFlight = transfers.filter(
    (t) => t.state.kind !== "uploaded" && t.state.kind !== "downloaded" && t.state.kind !== "failed",
  );
  if (inFlight.length > 0) {
    const percent = totalBytes > 0 ? Math.min(100, Math.round((doneBytes / totalBytes) * 100)) : 0;
    return { kind: "sending", percent };
  }
  if (failed.length > 0) {
    const first = failed[0].state;
    return { kind: "failed", errorClass: first.kind === "failed" ? first.errorClass : "unknown" };
  }
  return transfers[0]?.direction === "download" ? { kind: "downloaded" } : { kind: "uploaded" };
}

export interface TransferWidgetProps {
  connectionId: string;
  /** Called with a plain-language batch summary once a batch completes. */
  onBatchFinished?: (summary: string) => void;
}

const IN_FLIGHT_KINDS = new Set(["queued", "sending", "checking"]);

/** Duration of the fade/slide-out, in ms — kept in sync with the motion
 * `transition` below and used to time the widget's actual removal from the
 * DOM (driven by our own timer rather than motion's exit-animation
 * lifecycle, which is what actually unmounts it). */
const EXIT_ANIMATION_MS = 200;

/**
 * Floating, Google-Drive-style transfer widget pinned to the bottom-right of
 * the window. Hidden entirely when there's nothing to show for the current
 * connection; collapsible once transfers appear via the header's chevron.
 * Never auto-dismisses — like Drive's uploads panel, it stays on screen
 * until the user closes it with the header's close button. Failed
 * transfers are sticky — they stay rendered (and count toward the badge)
 * until the user explicitly dismisses them or closes the whole widget.
 *
 * Closing the widget while transfers are still in flight doesn't cancel
 * them — it just hides the widget; each row has its own stop button for
 * that. If further events arrive afterwards for still-running transfers,
 * the widget reappears with those, which mirrors Drive's own behavior of
 * staying visible during activity.
 *
 * Only ever shows transfers that became active while this widget was
 * mounted for the given connection — historical, already-uploaded entries
 * from `listTransfers` are filtered out on load so switching (or falling
 * back to another) connection never resurrects a stale "done" widget.
 */
export function TransferWidget({
  connectionId,
  onBatchFinished,
}: TransferWidgetProps) {
  const services = useServices();
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDismissed(new Set());
    void services.engine.listTransfers(connectionId).then((list) => {
      if (cancelled) return;
      setTransfers(
        list.filter((t) => t.state.kind !== "uploaded" && t.state.kind !== "downloaded"),
      );
    });

    const unsubscribe = services.engine.subscribe((event: EngineEvent) => {
      if (event.type === "transfer-updated") {
        if (event.transfer.connectionId !== connectionId) return;
        setTransfers((prev) => {
          const idx = prev.findIndex((t) => t.id === event.transfer.id);
          if (idx === -1) return [...prev, event.transfer];
          const next = prev.slice();
          next[idx] = event.transfer;
          return next;
        });
      } else if (event.type === "batch-finished") {
        const parts: string[] = [];
        if (event.uploaded > 0) {
          parts.push(
            `${event.uploaded} file${event.uploaded === 1 ? "" : "s"} uploaded`,
          );
        }
        if (event.failed > 0) {
          parts.push(
            `${event.failed} file${event.failed === 1 ? "" : "s"} failed`,
          );
        }
        const summary = parts.join(", ") || "Batch finished";
        services.notify("Lopload", summary);
        onBatchFinished?.(summary);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const visible = transfers.filter((t) => !dismissed.has(t.id));
  const inFlight = visible.filter((t) => IN_FLIGHT_KINDS.has(t.state.kind));
  const failed = visible.filter((t) => t.state.kind === "failed");
  const completedTransfers = visible.filter(
    (t) => t.state.kind === "uploaded" || t.state.kind === "downloaded",
  );

  function clearAll() {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const t of visible) next.add(t.id);
      return next;
    });
    for (const t of visible) void services.engine.dismiss(t.id);
  }

  // Failed count feeds the dock/taskbar badge, per spec.
  useEffect(() => {
    services.setBadgeCount(failed.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, dismissed, services]);

  const shouldShow = visible.length > 0;
  const total = visible.length;
  const completed = completedTransfers.length;

  // Both directions in the same batch keep the neutral "transfer" wording;
  // an all-upload or all-download batch gets the more specific verb.
  const hasUpload = visible.some((t) => t.direction === "upload");
  const hasDownload = visible.some((t) => t.direction === "download");
  const verb = hasUpload && hasDownload ? "transfer" : hasDownload ? "download" : "upload";
  const verbIng = verb === "transfer" ? "Transferring" : verb === "download" ? "Downloading" : "Uploading";

  // Drive-style dynamic title: "Uploading…" (or "Downloading…"/
  // "Transferring…") while anything's still in flight, then a completion
  // summary once the batch settles. Never auto-dismisses — the widget stays
  // up until the user closes it.
  const title =
    inFlight.length > 0
      ? `${verbIng} ${total} item${total === 1 ? "" : "s"}…`
      : failed.length > 0
        ? `${completed} of ${total} ${verb}s complete`
        : `${completed} ${verb}${completed === 1 ? "" : "s"} complete`;

  // Keep the widget mounted for a beat after shouldShow flips to false so
  // the fade/slide-out has time to play, then drop it from the tree
  // ourselves. Timed locally rather than via the animation library's own
  // exit-complete lifecycle, which onBatchFinished/auto-dismiss shouldn't
  // depend on to actually hide the widget.
  const [mounted, setMounted] = useState(shouldShow);
  useEffect(() => {
    if (shouldShow) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), EXIT_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [shouldShow]);

  if (!mounted) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: shouldShow ? 1 : 0, y: shouldShow ? 0 : 8 }}
      transition={{ duration: EXIT_ANIMATION_MS / 1000 }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed bottom-8 right-8 z-40 flex w-80 max-h-[70vh] flex-col overflow-hidden rounded-2xl bg-kumo-base shadow-lg ring-1 ring-kumo-line sm:w-96"
    >
      <div className="flex items-center justify-between gap-2 border-b border-kumo-line bg-kumo-elevated px-4 py-0 text-kumo-strong">
        <button
          type="button"
          className="lopload-body flex min-w-0 flex-1 items-center gap-2 py-3 text-left font-medium"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <span className="truncate tabular-nums">{title}</span>
        </button>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label={collapsed ? "Expand transfers" : "Collapse transfers"}
            className="relative flex h-8 w-8 items-center justify-center rounded-full text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96]"
            onClick={() => setCollapsed((c) => !c)}
          >
            <CaretDownIcon
              size={16}
              className={`transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`}
            />
          </button>
          <button
            type="button"
            aria-label="Close"
            className="relative flex h-8 w-8 items-center justify-center rounded-full text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96]"
            onClick={clearAll}
          >
            <XIcon size={16} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <ul className="flex flex-col gap-2 overflow-y-auto p-2">
          {groupTransfers(visible).map((row) => {
            const isFolder = row.transfers.length > 1 || row.folderName !== undefined;
            const state = isFolder ? rowState(row.transfers) : row.transfers[0].state;
            const totalSize = row.transfers.reduce((sum, t) => sum + t.size, 0);
            const name = isFolder ? row.folderName : row.transfers[0].key.split("/").pop();
            const sendingTransfer = row.transfers.find((t) => t.state.kind === "sending");
            const speed = sendingTransfer?.state.kind === "sending" ? sendingTransfer.state.speedBytesPerSec : undefined;
            const subtitle = isFolder
              ? `${row.transfers.length} file${row.transfers.length === 1 ? "" : "s"} • ${formatBytes(totalSize)}`
              : speed != null
                ? `${formatBytes(totalSize)} • ${formatSpeed(speed)}`
                : formatBytes(totalSize);
            const failedIds = row.transfers
              .filter((t) => t.state.kind === "failed")
              .map((t) => t.id);
            const inFlightIds = row.transfers
              .filter((t) => IN_FLIGHT_KINDS.has(t.state.kind))
              .map((t) => t.id);
            
            return (
              <li
                key={row.rowKey}
                className="lopload-settle flex flex-col gap-2 rounded-lg bg-kumo-base p-3 ring-1 ring-kumo-line"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2 lopload-body">
                    {isFolder && (
                      <FolderIcon size={16} className="flex-shrink-0 text-kumo-subtle" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{name}</p>
                      <p className="text-xs text-kumo-subtle tabular-nums">{subtitle}</p>
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <StatusChip
                      state={state}
                      direction={row.transfers[0].direction}
                    />
                    {inFlightIds.length > 0 && (
                      <button
                        type="button"
                        aria-label={`Cancel ${isFolder ? row.folderName : row.transfers[0].key}`}
                        className="relative flex h-8 w-8 items-center justify-center text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:text-kumo-default active:scale-[0.96]"
                        onClick={() => {
                          setTransfers((prev) =>
                            prev.filter((existing) => !inFlightIds.includes(existing.id)),
                          );
                          for (const id of inFlightIds) void services.engine.cancel(id);
                        }}
                      >
                        <StopCircleIcon size={16} />
                      </button>
                    )}
                    {!isFolder && state.kind === "downloaded" && (
                      <button
                        type="button"
                        aria-label="Show in folder"
                        className="relative flex h-8 w-8 cursor-pointer items-center justify-center text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:text-kumo-default active:scale-[0.96]"
                        onClick={() => void services.revealInFinder(row.transfers[0].localPath)}
                      >
                        <FolderOpenIcon size={16} />
                      </button>
                    )}
                    {state.kind === "failed" && (
                      <button
                        type="button"
                        aria-label={`Dismiss ${isFolder ? row.folderName : row.transfers[0].key}`}
                        className="relative flex h-8 w-8 items-center justify-center text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:text-kumo-default active:scale-[0.96]"
                        onClick={() => {
                          setDismissed((prev) => {
                            const next = new Set(prev);
                            for (const id of failedIds) next.add(id);
                            return next;
                          });
                          for (const id of failedIds) void services.engine.dismiss(id);
                        }}
                      >
                        <XIcon size={16} />
                      </button>
                    )}
                  </div>
                </div>
                {isFolder && sendingTransfer?.state.kind === "sending" && (
                  <div className="flex items-center gap-2 text-xs text-kumo-subtle ml-2">
                    <span className="truncate max-w-36">
                      {sendingTransfer.key.split("/").pop()}
                    </span>
                    <span className="tabular-nums shrink-0">
                      {sendingTransfer.state.percent}%
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </motion.div>
  );
}
