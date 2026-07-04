import { useEffect, useState } from "react";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo";
import type { Connection } from "../lib/types";
import { useServices } from "./services";
import { ConnectionSwitcher } from "./ConnectionSwitcher";
import { SetupScreen } from "./SetupScreen";
import { RemoteBrowser } from "./RemoteBrowser";
import { TransferPanel } from "./TransferPanel";

function AppShellInner() {
  const services = useServices();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const toasts = useKumoToastManager();

  useEffect(() => {
    void services.connections.list().then((list) => {
      setConnections(list);
      if (list.length > 0) {
        setCurrentId(list[0].id);
        setPrefix(list[0].lastPrefix);
      } else {
        setShowSetup(true);
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

  if (showSetup || !current) {
    return (
      <SetupScreen
        onSaved={handleSaved}
        onCancel={connections.length > 0 ? () => setShowSetup(false) : undefined}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col bg-kumo-canvas">
      <header className="flex items-center justify-between border-b border-kumo-line bg-kumo-base px-4 py-3">
        <h1 className="lopload-heading text-xl font-semibold">Lopload</h1>
        <ConnectionSwitcher
          connections={connections}
          currentId={currentId}
          onSwitch={switchTo}
          onAddStorage={() => setShowSetup(true)}
        />
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-2 gap-4 p-4">
        <section className="min-h-0 overflow-auto rounded-lg bg-kumo-base p-4 ring-1 ring-kumo-line">
          <RemoteBrowser connectionId={current.id} prefix={prefix} onNavigate={setPrefix} />
        </section>
        <section className="min-h-0 overflow-auto rounded-lg bg-kumo-base p-4 ring-1 ring-kumo-line">
          <TransferPanel
            connectionId={current.id}
            prefix={prefix}
            onBatchFinished={(summary) => toasts.add({ title: summary })}
          />
        </section>
      </main>
    </div>
  );
}

/** Top-level app layout: header switcher + remote browser + transfer panel. */
export function AppShell() {
  return (
    <Toasty>
      <AppShellInner />
    </Toasty>
  );
}
