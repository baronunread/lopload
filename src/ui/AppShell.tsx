import { useEffect, useState } from "react";
import { Toasty } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { useServices } from "./services";
import { ConnectionSwitcher } from "./ConnectionSwitcher";
import { AddStorageDialog } from "./AddStorageDialog";
import { Onboarding } from "./Onboarding";
import { RemoteBrowser } from "./RemoteBrowser";
import { TransferWidget } from "./TransferWidget";
import { ManageConnectionsDialog } from "./ManageConnectionsDialog";

function AppShellInner() {
  const services = useServices();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showManage, setShowManage] = useState(false);

  useEffect(() => {
    void services.connections.list().then((list) => {
      setConnections(list);
      if (list.length > 0) {
        setCurrentId(list[0].id);
        setPrefix(list[0].lastPrefix);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = connections.find((c) => c.id === currentId) ?? null;

  function switchTo(id: string) {
    const conn = connections.find((c) => c.id === id);
    setCurrentId(id);
    setPrefix(conn?.lastPrefix ?? "");
  }

  function handleSaved(conn: Connection) {
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === conn.id);
      if (idx === -1) return [...prev, conn];
      const next = prev.slice();
      next[idx] = conn;
      return next;
    });
    setCurrentId(conn.id);
    setPrefix(conn.lastPrefix);
    setShowSetup(false);
  }

  function handleDeleted(id: string) {
    const remaining = connections.filter((c) => c.id !== id);
    setConnections(remaining);
    if (id === currentId) {
      const fallback = remaining[0] ?? null;
      setCurrentId(fallback?.id ?? null);
      setPrefix(fallback?.lastPrefix ?? "");
    }
    if (remaining.length === 0) setShowManage(false);
  }

  if (connections.length === 0) {
    return <Onboarding onDone={handleSaved} />;
  }

  if (!current) return null;

  return (
    <div className="flex h-screen flex-col bg-kumo-canvas">
      <header className="flex items-center justify-between gap-3 border-b border-kumo-line bg-kumo-base px-4 py-3">
        <h1 className="lopload-heading shrink-0 text-xl font-semibold">Lopload</h1>
        <div className="min-w-0">
          <ConnectionSwitcher
            connections={connections}
            currentId={currentId}
            onSwitch={switchTo}
            onAddStorage={() => setShowSetup(true)}
            onManageStorage={() => setShowManage(true)}
          />
        </div>
      </header>

      {showSetup && (
        <AddStorageDialog onSaved={handleSaved} onClose={() => setShowSetup(false)} />
      )}

      {showManage && (
        <ManageConnectionsDialog
          connections={connections}
          onClose={() => setShowManage(false)}
          onDeleted={handleDeleted}
        />
      )}
      <main className="relative flex-1 overflow-auto p-4">
        <section className="h-full min-h-[40vh] overflow-auto rounded-lg bg-kumo-base p-4 ring-1 ring-kumo-line">
          <RemoteBrowser connectionId={current.id} prefix={prefix} onNavigate={setPrefix} />
        </section>
      </main>

      <TransferWidget connectionId={current.id} />
    </div>
  );
}

/** Top-level app layout: header switcher + remote browser + floating transfer widget. */
export function AppShell() {
  return (
    <Toasty>
      <AppShellInner />
    </Toasty>
  );
}
