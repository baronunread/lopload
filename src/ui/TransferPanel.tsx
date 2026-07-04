import { useEffect, useRef, useState } from "react";
import { Button, Empty } from "@cloudflare/kumo";
import { UploadSimpleIcon, XIcon } from "@phosphor-icons/react";
import type { EngineEvent, Transfer } from "../lib/types";
import { useServices } from "./services";
import { StatusChip } from "./StatusChip";
import { formatBytes } from "./format";

export interface TransferPanelProps {
  connectionId: string;
  prefix: string;
  /** Called with a plain-language batch summary once a batch completes. */
  onBatchFinished?: (summary: string) => void;
}

/**
 * Per-connection transfer list. Failed transfers are sticky — they stay
 * rendered (and count toward the badge) until the user explicitly dismisses
 * them, never auto-removed just because other transfers finished.
 */
export function TransferPanel({ connectionId, prefix, onBatchFinished }: TransferPanelProps) {
  const services = useServices();
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setDismissed(new Set());
    void services.engine.listTransfers(connectionId).then((list) => {
      if (!cancelled) setTransfers(list);
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
          parts.push(`${event.uploaded} file${event.uploaded === 1 ? "" : "s"} uploaded`);
        }
        if (event.failed > 0) {
          parts.push(`${event.failed} file${event.failed === 1 ? "" : "s"} failed`);
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

  // Failed count feeds the dock/taskbar badge, per spec.
  useEffect(() => {
    const failedCount = transfers.filter(
      (t) => t.state.kind === "failed" && !dismissed.has(t.id),
    ).length;
    services.setBadgeCount(failedCount);
  }, [transfers, dismissed, services]);

  useEffect(() => {
    return services.onFileDrop((paths) => {
      setDragging(false);
      dragCounter.current = 0;
      const files = paths.map((path) => ({
        path,
        name: path.split(/[/\\]/).pop() ?? path,
        size: 0,
      }));
      void services.engine.enqueueFiles(connectionId, prefix, files);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  async function handlePick() {
    const files = await services.pickFiles();
    if (files.length > 0) {
      await services.engine.enqueueFiles(connectionId, prefix, files);
    }
  }

  const visible = transfers.filter((t) => !dismissed.has(t.id));

  return (
    <div
      className="relative flex h-full flex-col gap-3"
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between">
        <h2 className="lopload-heading text-lg font-semibold">Transfers</h2>
        <Button variant="primary" icon={UploadSimpleIcon} onClick={() => void handlePick()}>
          Upload
        </Button>
      </div>

      {visible.length === 0 ? (
        <Empty title="No transfers yet" description="Drag files here or use Upload to send them." />
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((t) => (
            <li
              key={t.id}
              className="lopload-settle flex items-center justify-between gap-3 rounded-lg bg-kumo-base p-3 ring-1 ring-kumo-line"
            >
              <div className="min-w-0 lopload-body">
                <p className="truncate font-medium">{t.key.split("/").pop()}</p>
                <p className="text-xs text-kumo-subtle">{formatBytes(t.size)}</p>
              </div>
              <div className="flex items-center gap-2">
                <StatusChip
                  state={t.state}
                  onRetry={t.state.kind === "failed" ? () => void services.engine.retry(t.id) : undefined}
                />
                {t.state.kind === "failed" && (
                  <button
                    type="button"
                    aria-label={`Dismiss ${t.key}`}
                    className="text-kumo-subtle hover:text-kumo-default"
                    onClick={() => {
                      setDismissed((prev) => new Set(prev).add(t.id));
                      void services.engine.dismiss(t.id);
                    }}
                  >
                    <XIcon size={16} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {dragging && (
        <div className="lopload-drop-overlay absolute inset-0 flex items-center justify-center rounded-lg bg-kumo-brand/20 ring-2 ring-dashed ring-kumo-brand">
          <p className="lopload-heading text-lg font-semibold text-kumo-default">
            Drop to send
          </p>
        </div>
      )}
    </div>
  );
}
