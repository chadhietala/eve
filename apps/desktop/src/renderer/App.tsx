import { useCallback, useEffect, useState } from "react";

import { api, type Bot } from "./lib/api.js";
import { AddBot } from "./components/AddBot.js";
import { ComputerPane } from "./components/ComputerView.js";
import { Inspector, type InspectorTab } from "./components/Inspector.js";
import { Sidebar } from "./components/Sidebar.js";
import { Thread } from "./components/Thread.js";

type Pane = "inspector" | "thread" | "threads";
type MainView = "computer" | "thread";

export function App() {
  const [bots, setBots] = useState<readonly Bot[]>([]);
  const [backend, setBackend] = useState("unknown");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [inspector, setInspector] = useState<InspectorTab | null>(null);
  const [pane, setPane] = useState<Pane>("threads");
  const [mainView, setMainView] = useState<MainView>("thread");
  const [fatal, setFatal] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await api.state();
      setBots(state.bots);
      setBackend(state.computer.backend);
      setSelectedId((current) => current ?? state.bots[0]?.id ?? null);
    } catch (error) {
      setFatal(error instanceof Error ? error.message : "Could not reach the desktop server.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = bots.find((bot) => bot.id === selectedId) ?? null;
  const inspectorOpen = selected !== null && inspector !== null && mainView === "thread";

  function select(id: string): void {
    setSelectedId(id);
    setAdding(false);
    setMainView("thread");
    setPane("thread");
  }

  async function remove(id: string): Promise<void> {
    await api.deleteBot(id);
    setBots((current) => current.filter((bot) => bot.id !== id));
    setSelectedId((current) => (current === id ? null : current));
    setInspector(null);
  }

  if (fatal !== null) {
    return (
      <main className="thread__empty">
        <div>
          <h2>Not paired</h2>
          <p className="muted">{fatal}</p>
          <p className="muted">
            Open the link the desktop app prints, or start it with{" "}
            <span className="mono">eve-desktop</span>.
          </p>
        </div>
      </main>
    );
  }

  return (
    <div className="app" data-inspector={inspectorOpen ? "open" : "closed"} data-pane={pane}>
      <Sidebar
        backend={backend}
        bots={bots}
        onAdd={() => {
          setAdding(true);
          setPane("thread");
        }}
        onSelect={select}
        selectedId={adding ? null : selectedId}
      />

      {adding ? (
        <AddBot
          onCancel={() => setAdding(false)}
          onCreated={(bot) => {
            setBots((current) => [...current, bot]);
            setAdding(false);
            setSelectedId(bot.id);
          }}
        />
      ) : mainView === "computer" ? (
        <ComputerPane
          backend={backend}
          onClose={() => {
            setMainView("thread");
            setPane("thread");
          }}
        />
      ) : selected === null ? (
        <section className="thread">
          <div className="thread__empty">
            <div>
              <h2>No bot selected</h2>
              <p className="muted">Add an agent to start a conversation.</p>
            </div>
          </div>
        </section>
      ) : (
        <Thread
          bot={selected}
          computerOpen={false}
          key={selected.id}
          onBack={() => setPane("threads")}
          onToggleComputer={() => {
            setMainView("computer");
            setPane("thread");
          }}
          onToggleInspector={() => {
            setInspector((current) => (current === null ? "details" : null));
            setPane("inspector");
          }}
        />
      )}

      {inspectorOpen ? (
        <Inspector
          bot={selected}
          onChange={(bot) =>
            setBots((current) => current.map((entry) => (entry.id === bot.id ? bot : entry)))
          }
          onClose={() => {
            setInspector(null);
            setPane("thread");
          }}
          onDelete={(id) => void remove(id)}
          onTabChange={setInspector}
          tab={inspector}
        />
      ) : null}
    </div>
  );
}
