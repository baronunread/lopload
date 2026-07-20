import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Badge, Meter } from "@cloudflare/kumo";
import { LazyMotion, m, domAnimation } from "motion/react";
import {
  BroomIcon,
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

/** Present-tense verb for a row/title still in flight, per kind — rename/
 * drag-move, move to Trash, restore out of Trash, and permanent delete
 * (Delete now / Empty trash) all reuse the same MoveProgress tracking (see
 * appServices.ts's runTracked), so the widget is what tells them apart. */
function movingVerb(kind: MoveProgress["kind"]): string {
  switch (kind) {
    case "trash":
      return "Moving to Trash";
    case "restore":
      return "Restoring";
    case "purge":
      return "Deleting";
    case "move":
      return "Moving";
  }
}

/** Past-tense verb for a row/title that already landed, per kind. */
function completedVerb(kind: MoveProgress["kind"]): string {
  switch (kind) {
    case "trash":
      return "moved to Trash";
    case "restore":
      return "restored";
    case "purge":
      return "deleted";
    case "move":
      return "moved";
  }
}

function failedLabel(kind: MoveProgress["kind"]): string {
  switch (kind) {
    case "trash":
      return "Couldn't move to Trash";
    case "restore":
      return "Couldn't restore";
    case "purge":
      return "Couldn't delete";
    case "move":
      return "Couldn't move";
  }
}

/** Badge text for a settled row, per kind. */
function completedBadgeLabel(kind: MoveProgress["kind"]): string {
  switch (kind) {
    case "trash":
      return "Moved ✓";
    case "restore":
      return "Restored ✓";
    case "purge":
      return "Deleted ✓";
    case "move":
      return "Moved ✓";
  }
}

/** The row's display name: a rename/drag-move shows where the item is going
 * (`toKey`), but Trash/restore/purge rows have no meaningful destination —
 * `fromKey` and `toKey` are the same original path — so they show what the
 * operation is acting on instead. */
function moveDisplayName(move: MoveProgress): string {
  return baseName(move.kind === "move" ? move.toKey : move.fromKey);
}

const IN_FLIGHT_KINDS = new Set(["queued", "sending", "checking"]);

/** One row of in-flight/settled folder-move progress. Reads `dismissMove`
 * straight from context rather than taking it as a prop — it's the same
 * MoveProgressContext the parent already reads `moves` from. */
function MoveRow({ move }: { move: MoveProgress }) {
  const { dismissMove } = useMoveProgress();
  return (
    <li className="lopload-settle flex items-center justify-between gap-2 rounded-lg bg-kumo-base p-3 ring-1 ring-kumo-line">
      <div className="flex min-w-0 flex-1 items-center gap-2 lopload-body">
        <FolderIcon size={16} className="flex-shrink-0 text-kumo-subtle" />
        <div className="min-w-0">
          <p className="truncate font-medium">
            {moveDisplayName(move)}
          </p>
          <p className="truncate text-xs text-kumo-subtle tabular-nums">
            {move.status === "moving"
              ? move.totalItems > 0
                ? moveDetail(move)
                : `${movingVerb(move.kind)}…`
              : move.status === "completed"
                ? `${move.totalItems} item${move.totalItems === 1 ? "" : "s"} ${completedVerb(move.kind)}`
                : (move.errorMessage ?? failedLabel(move.kind))}
          </p>
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {move.status === "moving" && move.totalItems > 0 && (
          <div className="flex w-36 items-center">
            <Meter
              label={movingVerb(move.kind)}
              value={movePercent(move)}
              showValue
              className="w-full"
              trackClassName="!h-1"
              indicatorClassName="bg-kumo-warning"
            />
          </div>
        )}
        {move.status === "completed" && (
          <Badge variant="success">{completedBadgeLabel(move.kind)}</Badge>
        )}
        {move.status === "failed" && (
          <Badge variant="error">{failedLabel(move.kind)}</Badge>
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
  );
}

/** One row of file-transfer progress: either a lone file or a whole
 * dropped/picked folder collapsed into one aggregated row (see
 * `groupTransfers`). Takes the parent's `transfers` state setters directly —
 * they're stable `useState` setters, so passing them down avoids a layer of
 * callback wrappers that would just forward the same calls. */
function TransferRow({
  row,
  setTransfers,
  setDismissed,
}: {
  row: DisplayRow;
  setTransfers: Dispatch<SetStateAction<Transfer[]>>;
  setDismissed: Dispatch<SetStateAction<Set<string>>>;
}) {
  const services = useServices();
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
  // Single pass each — was filter().map(), iterating row.transfers twice for
  // what's typically a handful of files.
  const failedIds = row.transfers.flatMap((t) => (t.state.kind === "failed" ? [t.id] : []));
  const inFlightIds = row.transfers.flatMap((t) =>
    IN_FLIGHT_KINDS.has(t.state.kind) ? [t.id] : [],
  );

  return (
    <li className="lopload-settle flex flex-col gap-2 rounded-lg bg-kumo-base p-3 ring-1 ring-kumo-line">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 lopload-body">
          {isFolder && (
            <FolderIcon size={16} className="flex-shrink-0 text-kumo-subtle" />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{name}</p>
            <p className="truncate text-xs text-kumo-subtle tabular-nums">{subtitle}</p>
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
                // Built once, looked up per row of `prev` below — was an
                // .includes() on the plain array inside the filter callback.
                const cancelIds = new Set(inFlightIds);
                setTransfers((prev) =>
                  prev.filter((existing) => !cancelIds.has(existing.id)),
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
}

interface TitleParts {
  movingMoves: MoveProgress[];
  inFlight: Transfer[];
  visibleTransfers: Transfer[];
  visibleMoves: MoveProgress[];
  failed: Transfer[];
  failedMoves: MoveProgress[];
  completedTransfers: Transfer[];
  completedMoves: MoveProgress[];
  verb: string;
  verbIng: string;
  total: number;
  completed: number;
}

/** Drive-style dynamic title: says what's still happening while anything's in
 * flight, then summarizes once the batch settles. A title counts only what's
 * actually still running — rows that already finished stay listed below, but
 * "Moving 3 items…" next to two "Moved ✓" rows would just be wrong. */
function widgetTitle(p: TitleParts): string {
  if (p.movingMoves.length > 0 && p.inFlight.length > 0) {
    const n = p.movingMoves.length + p.inFlight.length;
    return `Transferring ${n} item${n === 1 ? "" : "s"}…`;
  }
  if (p.movingMoves.length > 0) {
    const n = p.movingMoves.length;
    // A mixed batch (say, a rename alongside a Trash move) falls back to
    // the neutral "Moving" rather than picking one kind's verb arbitrarily.
    const kinds = new Set(p.movingMoves.map((m) => m.kind));
    const moveVerb = kinds.size === 1 ? movingVerb(p.movingMoves[0].kind) : "Moving";
    // For a real bulk batch, count *up* the items actually finished toward the
    // batch total, rather than the in-flight count alone: that count sits
    // pinned at BULK_OP_CONCURRENCY while the queue drains, then ticks
    // 3 → 2 → 1 — a countdown that reads as the opposite of progress.
    // ponytail: two distinct large batches in flight at once share one total
    // (the larger) — add a batchId if that ever actually comes up.
    const batchTotal = Math.max(0, ...p.movingMoves.map((m) => m.batchTotal ?? 0));
    if (batchTotal > 1) {
      const done = p.completedMoves.length;
      return `Moved ${done} of ${batchTotal} items…`;
    }
    return `${moveVerb} ${n} item${n === 1 ? "" : "s"}…`;
  }
  if (p.inFlight.length > 0) {
    const n = p.visibleTransfers.length;
    return `${p.verbIng} ${n} item${n === 1 ? "" : "s"}…`;
  }
  // Nothing left in flight — summarize what landed.
  if (p.visibleTransfers.length === 0) {
    const n = p.completedMoves.length;
    if (p.failedMoves.length > 0) {
      return `${n} of ${p.visibleMoves.length} moves complete`;
    }
    const kinds = new Set(p.visibleMoves.map((m) => m.kind));
    const verbed = kinds.size === 1 ? completedVerb(p.visibleMoves[0].kind) : "moved";
    return `${n} item${n === 1 ? "" : "s"} ${verbed}`;
  }
  if (p.visibleMoves.length === 0) {
    return p.failed.length > 0
      ? `${p.completedTransfers.length} of ${p.visibleTransfers.length} ${p.verb}s complete`
      : `${p.completedTransfers.length} ${p.verb}${p.completedTransfers.length === 1 ? "" : "s"} complete`;
  }
  return p.failed.length > 0 || p.failedMoves.length > 0
    ? `${p.completed} of ${p.total} complete`
    : `${p.completed} complete`;
}

export interface TransferWidgetProps {
  connectionId: string;
  /** Called with a plain-language batch summary once a batch completes. */
  onBatchFinished?: (summary: string) => void;
  /** True while the update banner is showing, so the widget lifts clear of
   * it instead of the two overlapping in the bottom-right corner. */
  liftedForUpdateBanner?: boolean;
}

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
  liftedForUpdateBanner,
}: TransferWidgetProps) {
  const services = useServices();
  const { moves: allMoves, dismissMove, clearCompleted } = useMoveProgress();
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

  // Sweeps away only the rows that are done with (finished or failed) and
  // leaves anything still running, unlike clearAll's close button which wipes
  // everything. Settled transfers are anything not in an in-flight kind.
  const settledTransfers = visibleTransfers.filter((t) => !IN_FLIGHT_KINDS.has(t.state.kind));
  const hasProcessed = settledTransfers.length > 0 || visibleMoves.some((m) => m.status !== "moving");
  function clearProcessed() {
    setDismissed((prev) => {
      const next = new Set(prev);
      for (const t of settledTransfers) next.add(t.id);
      return next;
    });
    for (const t of settledTransfers) void services.engine.dismiss(t.id);
    clearCompleted();
  }

  // Failed count feeds the dock/taskbar badge, per spec. Keyed on the count
  // itself rather than the arrays it comes from: those are rebuilt on every
  // render, and this effect crosses into Rust — during a download it would
  // fire an IPC call on every progress tick to report a number that hasn't
  // changed.
  const badgeCount = failed.length + failedMoves.length;
  useEffect(() => {
    services.setBadgeCount(badgeCount);
  }, [badgeCount, services]);

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

  // Drive-style dynamic title (see widgetTitle's doc comment for the rules).
  const title = widgetTitle({
    movingMoves,
    inFlight,
    visibleTransfers,
    visibleMoves,
    failed,
    failedMoves,
    completedTransfers,
    completedMoves,
    verb,
    verbIng,
    total,
    completed,
  });

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
    <LazyMotion features={domAnimation}>
      <m.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: shouldShow ? 1 : 0, y: shouldShow ? 0 : 8 }}
        transition={{ duration: EXIT_ANIMATION_MS / 1000 }}
        className={`fixed right-8 z-40 flex w-80 max-h-[70vh] flex-col overflow-hidden rounded-2xl bg-kumo-base shadow-lg ring-1 ring-kumo-line transition-[bottom] sm:w-[26rem] ${
          liftedForUpdateBanner ? "bottom-20" : "bottom-8"
        }`}
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
            {hasProcessed && (
              <button
                type="button"
                aria-label="Clear finished"
                title="Clear finished"
                className="relative flex h-8 w-8 items-center justify-center rounded-full text-kumo-subtle transition-transform after:absolute after:-inset-1 hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96]"
                onClick={clearProcessed}
              >
                <BroomIcon size={16} />
              </button>
            )}
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
              <MoveRow key={move.moveId} move={move} />
            ))}

            {groupTransfers(visibleTransfers).map((row) => (
              <TransferRow
                key={row.rowKey}
                row={row}
                setTransfers={setTransfers}
                setDismissed={setDismissed}
              />
            ))}
          </ul>
        )}
      </m.div>
    </LazyMotion>
  );
}
