import { ArrowLeft, Gamepad2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import { listCommunityGames, waitForRuntime } from "./api.js";

export function Community({ onHome }: { onHome: () => void }) {
  const [games, setGames] = useState<CommunityGame[]>([]);
  const [selected, setSelected] = useState<CommunityGame>();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  async function load() {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const loaded = await listCommunityGames();
      setGames(loaded);
      setSelected((current) => loaded.find((game) => game.id === current?.id));
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <main className="community-shell">
      <header className="community-header">
        <button className="icon-button quiet-button" type="button" onClick={onHome} title="Back to Home" aria-label="Back to Home">
          <ArrowLeft size={15} />
        </button>
        <h1>Community</h1>
        <button className="icon-button quiet-button" type="button" onClick={() => void load()} title="Refresh" aria-label="Refresh">
          <RefreshCw className={phase === "loading" ? "spin" : undefined} size={15} />
        </button>
      </header>

      <section className="community-content">
        {phase === "loading" ? <div className="community-state"><LoaderCircle className="spin" size={20} />Loading games</div> : null}
        {phase === "error" ? <div className="community-state community-error"><X size={20} />{error}</div> : null}
        {phase === "ready" && games.length === 0 ? <div className="community-state">No published games yet</div> : null}
        {phase === "ready" && games.length > 0 ? (
          <div className="community-grid">
            {games.map((game) => (
              <button className="community-game" type="button" key={game.id} onClick={() => setSelected(game)}>
                <span className="community-game-preview"><Gamepad2 size={28} /></span>
                <strong title={game.title}>{game.title}</strong>
                <span>{publishedDate(game.publishedAt)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {selected ? (
        <div className="game-player" role="dialog" aria-modal="true" aria-label={selected.title}>
          <header>
            <strong>{selected.title}</strong>
            <div>
              <button className="icon-button quiet-button" type="button" onClick={() => setSelected(undefined)} title="Close" aria-label="Close">
                <X size={15} />
              </button>
            </div>
          </header>
          <iframe src={selected.playUrl} title={selected.title} sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts" />
        </div>
      ) : null}
    </main>
  );
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
