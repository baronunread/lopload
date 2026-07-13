import { useEffect, useState } from "react";
import { Badge, Meter } from "@cloudflare/kumo";
import { motion } from "motion/react";
import {
  CaretDownIcon,
  FolderIcon,
  FolderOpenIcon,
  StopCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { EngineEvent, Transfer, TransferState } from "../lib/types";
import type { MoveProgress } from "./services";
import { useServices } from "./services";
import { StatusChip } from "./StatusChip";
import { formatBytes, formatSpeed } from "./format";
import { useMoveProgress } from "./browser/MoveProgressContext";

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

function baseName(key: string): string {
  const trimmed = key.endsWith("/") ? key.slice(0, -1) : key;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Percentage for a move, off bytes where we have them (an item count reads as
 * 0% for minutes on a folder of huge files) and off items otherwise, for a
 * folder that's all empty markers. Held below 100 until the move actually
 * reports completion — copying is followed by a delete pass, so a full bar
 * next to a still-spinning row would be a lie. */
function movePercent(move: MoveProgress): number {
  if (move.status === "completed") return 100;
  const fraction =
    move.totalBytes > 0
      ? move.copiedBytes / move.totalBytes
      : move.totalItems > 0
        ? move.copiedItems / move.totalItems
        : 0;
  return Math.min(99, Math.floor(fraction * 100));
}

/**
 * "4.2 GB of 18.1 GB · 13 items", falling back to "3 of 13 items" for a folder
 * with no bytes to speak of.
 *
 * Deliberately not a running "N of 13 items" count next to the bytes: objects
 * are copied several at a time, so a dozen of them can each be most of the way
 * across with none of them *finished* — a bar reading 57% beside "1 of 13
 * items" looks broken even though both numbers are true. Bytes are the honest
 * measure of how far along a move is, so bytes lead and the item count is
 * reported as what it reliably is, a total.
 */
function moveDetail(move: MoveProgress): string {
  if (move.totalBytes === 0) {
    return `${move.copiedItems} of ${move.totalItems} item${move.totalItems === 1 ? "" : "s"}`;
  }
  const items = `${move.totalItems} item${move.totalItems === 1 ? "" : "s"}`;
  return `${formatBytes(move.copiedBytes)} of ${formatBytes(move.totalBytes)} · ${items}`;
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
 * Also shows in-flight folder move progress (drag-to-move / "Move to…")
 * from BrowserService.subscribeMoves, so the user sees non-blocking
 * progress instead of a blocking dialog.
 */
export function TransferWidget({
  connectionId,
  onBatchFinished,
}: TransferWidgetProps) {
  const services = useServices();
  const { moves: allMoves, dismissMove } = useMoveProgress();
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

  const visibleMoves = allMoves.filter((m) => m.connectionId === connectionId);
  const visibleTransfers = transfers.filter((t) => !dismissed.has(t.id));
  const inFlight = visibleTransfers.filter((t) => IN_FLIGHT_KINDS.has(t.state.kind));
  const failed = visibleTransfers.filter((t) => t.state.kind === "failed");
  const completedTransfers = visibleTransfers.filter(
    (t) => t.state.kind === "uploaded" || t.state.kind === "downloaded",
  );

  const movingMoves = visibleMoves.filter((m) => m.status === "moving");
  const failedMoves = visibleMoves.filter((m) => m.status === "failed");

  function clearAll() {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const t of visibleTransfers) next.add(t.id);
      return next;
    });
    for (const t of visibleTransfers) void services.engine.dismiss(t.id);
    for (const m of visibleMoves) dismissMove(m.moveId);
  }

  // Failed count feeds the dock/taskbar badge, per spec.
  useEffect(() => {
    services.setBadgeCount(failed.length + failedMoves.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, dismissed, visibleMoves, services]);

  const shouldShow = visibleTransfers.length > 0 || visibleMoves.length > 0;
  const total = visibleTransfers.length + visibleMoves.length;
  const completed = completedTransfers.length + visibleMoves.filter((m) => m.status === "completed").length;

  const hasUpload = visibleTransfers.some((t) => t.direction === "upload");
  const hasDownload = visibleTransfers.some((t) => t.direction === "download");
  const completedMoves = visibleMoves.filter((m) => m.status === "completed");

  // Both directions in the same batch keep the neutral "transfer" wording; an
  // all-upload or all-download batch gets the more specific verb.
  const verb = hasUpload && hasDownload ? "transfer" : hasDownload ? "download" : "upload";
  const verbIng =
    verb === "transfer" ? "Transferring" : verb === "download" ? "Downloading" : "Uploading";

  // Drive-style dynamic title: says what's still happening while anything's in
  // flight, then summarizes once the batch settles. A title counts only what's
  // actually still running — rows that already finished stay listed below, but
  // "Moving 3 items…" next to two "Moved ✓" rows would just be wrong.
  const title = (() => {
    if (movingMoves.length > 0 && inFlight.length > 0) {
      const n = movingMoves.length + inFlight.length;
      return `Transferring ${n} item${n === 1 ? "" : "s"}…`;
    }
    if (movingMoves.length > 0) {
      const n = movingMoves.length;
      return `Moving ${n} item${n === 1 ? "" : "s"}…`;
    }
    if (inFlight.length > 0) {
      const n = visibleTransfers.length;
      return `${verbIng} ${n} item${n === 1 ? "" : "s"}…`;
    }
    // Nothing left in flight — summarize what landed.
    if (visibleTransfers.length === 0) {
      const n = completedMoves.length;
      return failedMoves.length > 0
        ? `${n} of ${visibleMoves.length} moves complete`
        : `${n} item${n === 1 ? "" : "s"} moved`;
    }
    if (visibleMoves.length === 0) {
      return failed.length > 0
        ? `${completedTransfers.length} of ${visibleTransfers.length} ${verb}s complete`
        : `${completedTransfers.length} ${verb}${completedTransfers.length === 1 ? "" : "s"} complete`;
    }
    return failed.length > 0 || failedMoves.length > 0
      ? `${completed} of ${total} complete`
      : `${completed} complete`;
  })();

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
          {visibleMoves.map((move) => (
            <li
              key={move.moveId}
              className="lopload-settle flex items-center justify-between gap-2 rounded-lg bg-kumo-base p-3 ring-1 ring-kumo-line"
            >
              <div className="flex min-w-0 items-center gap-2 lopload-body">
                <FolderIcon size={16} className="flex-shrink-0 text-kumo-subtle" />
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {baseName(move.toKey)}
                  </p>
                  <p className="text-xs text-kumo-subtle tabular-nums">
                    {move.status === "moving"
                      ? move.totalItems > 0
                        ? moveDetail(move)
                        : "Preparing…"
                      : move.status === "completed"
                        ? `${move.totalItems} item${move.totalItems === 1 ? "" : "s"} moved`
                        : move.errorMessage ?? "Couldn't move"}
                  </p>
                </div>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                {move.status === "moving" && move.totalItems > 0 && (
                  <Meter
                    label={`Moving ${movePercent(move)}%`}
                    value={movePercent(move)}
                    showValue
                    className="min-w-40"
                    trackClassName="!h-1"
                    indicatorClassName="bg-kumo-warning"
                  />
                )}
                {move.status === "completed" && (
                  <Badge variant="success">Moved ✓</Badge>
                )}
                {move.status === "failed" && (
                  <Badge variant="error">Couldn't move</Badge>
                )}
                {(move.status === "completed" || move.status === "failed") && (
                  <button
                    type="button"
                    aria-label="Dismiss"
                    className="relative flex h-8 w-8 items-center justify-center text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:text-kumo-default active:scale-[0.96]"
                    onClick={() => dismissMove(move.moveId)}
                  >
                    <XIcon size={16} />
                  </button>
                )}
              </div>
            </li>
          ))}

          {groupTransfers(visibleTransfers).map((row) => {
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
