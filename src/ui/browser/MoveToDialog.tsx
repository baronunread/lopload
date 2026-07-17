import { useEffect, useState } from "react";
import { Breadcrumbs, Button, Dialog } from "@cloudflare/kumo";
import { FolderIcon, HouseIcon, XIcon } from "@phosphor-icons/react";
import type { RemoteEntry } from "../../lib/types";
import { useServices } from "../services";
import { segmentsForPrefix } from "../format";

export interface MoveToDialogProps {
  connectionId: string;
  /** Full keys of the rows being moved (files, or "folder/" prefixes). */
  sourceKeys: string[];
  /** The folder the sources currently live in — "Move here" is disabled
   * while browsing it, since that move would be a no-op. */
  currentPrefix: string;
  onClose: () => void;
  /** Performs the actual move (the browser's handleMove, which refreshes). */
  onMove: (fromKeys: string[], toPrefix: string) => Promise<void>;
}

/** Folder picker for the "Move to…" context-menu action: navigate the
 * folder tree, then confirm with "Move here". Folders that are themselves
 * being moved can't be entered — a folder can't move into itself. */
export function MoveToDialog({
  connectionId,
  sourceKeys,
  currentPrefix,
  onClose,
  onMove,
}: MoveToDialogProps) {
  const services = useServices();
  const [prefix, setPrefix] = useState(currentPrefix);
  const [folders, setFolders] = useState<RemoteEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFolders(null);
    void services.browser.list(connectionId, prefix).then((entries) => {
      if (cancelled) return;
      setFolders(entries.filter((e) => e.kind === "folder"));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  const segments = segmentsForPrefix(prefix);
  const sourceSet = new Set(sourceKeys);

  function confirm() {
    onMove(sourceKeys, prefix);
    onClose();
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog className="w-full sm:w-full max-w-md p-6">
        <div className="flex items-center gap-3">
          <Dialog.Title className="m-0">
            Move {sourceKeys.length === 1 ? "1 item" : `${sourceKeys.length} items`} to…
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
        <div className="mt-3">
          <Breadcrumbs>
            {/* Wraps Breadcrumbs.Link's real <a href="#"> (display:contents,
                no box of its own) — keyboard users reach and activate it via
                that anchor, and the click bubbles up to this span, so no
                separate role/tabIndex is needed here. */}
            <span
              className="contents"
              onClick={(e) => {
                e.preventDefault();
                setPrefix("");
              }}
            >
              <Breadcrumbs.Link href="#" icon={<HouseIcon size={16} />}>
                Home
              </Breadcrumbs.Link>
            </span>
            {segments.map((segment, i) => {
              const segPrefix = segments.slice(0, i + 1).join("/") + "/";
              const isLast = i === segments.length - 1;
              return (
                <span key={segPrefix} className="contents">
                  <Breadcrumbs.Separator />
                  {isLast ? (
                    <Breadcrumbs.Current>{segment}</Breadcrumbs.Current>
                  ) : (
                    // Same wrapper-around-a-real-anchor pattern as the Home
                    // crumb above.
                    <span
                      className="contents"
                      onClick={(e) => {
                        e.preventDefault();
                        setPrefix(segPrefix);
                      }}
                    >
                      <Breadcrumbs.Link href="#">{segment}</Breadcrumbs.Link>
                    </span>
                  )}
                </span>
              );
            })}
          </Breadcrumbs>
        </div>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg ring-1 ring-inset ring-kumo-line">
          {folders !== null && folders.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-kumo-subtle">No folders in here.</p>
          ) : (
            <ul className="divide-y divide-kumo-line">
              {(folders ?? []).map((folder) => {
                const isSource = sourceSet.has(folder.key);
                return (
                  <li key={folder.key}>
                    <button
                      type="button"
                      disabled={isSource}
                      title={isSource ? "Can't move a folder into itself" : undefined}
                      className="lopload-body flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      onClick={() => setPrefix(folder.key)}
                    >
                      <FolderIcon size={18} weight="fill" className="shrink-0 text-kumo-brand" />
                      <span className="truncate">{folder.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="primary"
            disabled={prefix === currentPrefix}
            onClick={() => confirm()}
          >
            Move here
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
