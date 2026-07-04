import { useEffect, useState } from "react";
import {
  Breadcrumbs,
  Button,
  Dialog,
  Empty,
  Input,
  Table,
} from "@cloudflare/kumo";
import { DotsThreeVerticalIcon, FolderPlusIcon, HouseIcon } from "@phosphor-icons/react";
import type { RemoteEntry } from "../lib/types";
import { useServices } from "./services";
import { formatBytes, formatDate, segmentsForPrefix } from "./format";
import { Thumbnail } from "./Thumbnail";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

export interface RemoteBrowserProps {
  connectionId: string;
  prefix: string;
  onNavigate: (prefix: string) => void;
}

type PendingAction =
  | { kind: "new-folder" }
  | { kind: "rename"; entry: RemoteEntry }
  | { kind: "delete"; entry: RemoteEntry };

/** Remote folder browser: breadcrumbs, listing table, thumbnails, and a right-click menu. */
export function RemoteBrowser({ connectionId, prefix, onNavigate }: RemoteBrowserProps) {
  const services = useServices();
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: RemoteEntry } | null>(
    null,
  );
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingName, setPendingName] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      const result = await services.browser.list(connectionId, prefix);
      setEntries(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, prefix]);

  function navigate(next: string) {
    onNavigate(next);
    void services.connections.setLastPrefix(connectionId, next);
  }

  const folders = entries.filter((e) => e.kind === "folder");
  const files = entries.filter((e) => e.kind === "file");
  const rows = [...folders, ...files];
  const segments = segmentsForPrefix(prefix);

  function contextItemsFor(entry?: RemoteEntry): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        label: "New folder",
        onSelect: () => {
          setPendingName("");
          setPending({ kind: "new-folder" });
        },
      },
    ];
    if (entry) {
      items.unshift(
        {
          label: "Rename",
          onSelect: () => {
            setPendingName(entry.name);
            setPending({ kind: "rename", entry });
          },
        },
        {
          label: "Copy link",
          onSelect: () => {
            void services.browser.copyLink(connectionId, entry.key).then((link) => {
              void navigator.clipboard?.writeText(link);
            });
          },
        },
      );
      items.push({
        label: "Delete",
        danger: true,
        onSelect: () => setPending({ kind: "delete", entry }),
      });
    }
    return items;
  }

  async function confirmPending() {
    if (!pending) return;
    if (pending.kind === "new-folder") {
      await services.browser.createFolder(connectionId, prefix, pendingName);
    } else if (pending.kind === "rename") {
      await services.browser.rename(connectionId, pending.entry.key, pendingName);
    } else if (pending.kind === "delete") {
      await services.browser.delete(connectionId, pending.entry.key);
    }
    setPending(null);
    await refresh();
  }

  return (
    <div
      className="flex h-full flex-col gap-3"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Breadcrumbs>
          <span
            className="contents"
            onClick={(e) => {
              e.preventDefault();
              navigate("");
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
                  <span
                    className="contents"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(segPrefix);
                    }}
                  >
                    <Breadcrumbs.Link href="#">{segment}</Breadcrumbs.Link>
                  </span>
                )}
              </span>
            );
          })}
        </Breadcrumbs>
        <Button
          variant="secondary"
          size="sm"
          icon={FolderPlusIcon}
          onClick={() => {
            setPendingName("");
            setPending({ kind: "new-folder" });
          }}
        >
          New folder
        </Button>
      </div>

      {!loading && rows.length === 0 ? (
        <Empty title="This folder is empty" description="Drag files in, or use Upload." />
      ) : (
        <Table layout="fixed">
          <Table.Header>
            <Table.Row>
              <Table.Head className="w-auto p-2 sm:p-3">Name</Table.Head>
              <Table.Head className="w-16 p-2 sm:w-24 sm:p-3">Size</Table.Head>
              <Table.Head className="hidden w-32 p-2 sm:table-cell sm:p-3">Modified</Table.Head>
              <Table.Head className="w-9 p-2 sm:w-12 sm:p-3">
                <span className="sr-only">Actions</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((entry) => (
              <Table.Row
                key={entry.key}
                className="h-12 sm:h-auto"
                onDoubleClick={() => {
                  if (entry.kind === "folder") navigate(entry.key);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, entry });
                }}
              >
                <Table.Cell className="flex min-w-0 items-center gap-2 p-2 sm:p-3">
                  <Thumbnail
                    connectionId={connectionId}
                    entryKey={entry.key}
                    name={entry.name}
                    kind={entry.kind}
                  />
                  <span className="lopload-body truncate">{entry.name}</span>
                </Table.Cell>
                <Table.Cell className="lopload-body whitespace-nowrap p-2 text-kumo-subtle sm:p-3">
                  {entry.kind === "file" ? formatBytes(entry.size ?? 0) : "—"}
                </Table.Cell>
                <Table.Cell className="hidden whitespace-nowrap p-2 lopload-body text-kumo-subtle sm:table-cell sm:p-3">
                  {formatDate(entry.lastModified)}
                </Table.Cell>
                <Table.Cell className="p-1 text-right sm:p-2">
                  <Button
                    variant="ghost"
                    shape="square"
                    size="sm"
                    aria-label={`Actions for ${entry.name}`}
                    icon={DotsThreeVerticalIcon}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setMenu({ x: rect.left, y: rect.bottom, entry });
                    }}
                  />
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={contextItemsFor(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        role={pending?.kind === "delete" ? "alertdialog" : "dialog"}
      >
        {pending && (
          <Dialog className="p-6">
            {pending.kind === "delete" ? (
              <>
                <Dialog.Title>Delete {pending.entry.name}?</Dialog.Title>
                <Dialog.Description>This can't be undone.</Dialog.Description>
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                    Cancel
                  </Dialog.Close>
                  <Button variant="destructive" onClick={() => void confirmPending()}>
                    Delete
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Dialog.Title>
                  {pending.kind === "new-folder" ? "New folder" : "Rename"}
                </Dialog.Title>
                <Input
                  label="Name"
                  value={pendingName}
                  onChange={(e) => setPendingName(e.target.value)}
                  autoFocus
                />
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close render={(p) => <Button variant="secondary" {...p} />}>
                    Cancel
                  </Dialog.Close>
                  <Button
                    variant="primary"
                    disabled={!pendingName.trim()}
                    onClick={() => void confirmPending()}
                  >
                    Save
                  </Button>
                </div>
              </>
            )}
          </Dialog>
        )}
      </Dialog.Root>
    </div>
  );
}
