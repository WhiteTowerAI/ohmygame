import { ArrowLeft, ExternalLink, Gamepad2, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import { getCommunityGame, listCommunityGames, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import type { SidebarPage } from "./routes.js";

export function Community({
  onNavigate,
  onOpenGame,
}: {
  onNavigate: (page: SidebarPage) => void;
  onOpenGame: (gameId: string) => void;
}) {
  const [games, setGames] = useState<CommunityGame[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  async function load() {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const loaded = await listCommunityGames();
      setGames(loaded);
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <main className="home-shell">
      <AppSidebar active="community" onNavigate={onNavigate} />
      <section className="community-shell">
        <header className="community-header">
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
                <button className="community-game" type="button" key={game.id} onClick={() => onOpenGame(game.id)}>
                  <span className="community-game-preview"><Gamepad2 size={28} /></span>
                  <strong title={game.title}>{game.title}</strong>
                  <span>{publishedDate(game.publishedAt)}</span>
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

export function CommunityGamePlayer({ gameId, onBack }: { gameId: string; onBack: () => void }) {
  const [game, setGame] = useState<CommunityGame>();
  const [error, setError] = useState<string>();

  async function load() {
    setGame(undefined);
    setError(undefined);
    try {
      await waitForRuntime();
      setGame(await getCommunityGame(gameId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => { void load(); }, [gameId]);

  return (
    <main className="community-player-page">
      <header className="community-player-header">
        <button className="community-player-back" type="button" onClick={onBack}>
          <ArrowLeft size={15} />
          Community
        </button>
        <strong title={game?.title}>{game?.title ?? "Game"}</strong>
        <button
          className="icon-button quiet-button"
          type="button"
          disabled={!game}
          onClick={() => game && window.open(game.playUrl, "_blank", "noopener,noreferrer")}
          title="Open externally"
          aria-label="Open externally"
        >
          <ExternalLink size={15} />
        </button>
      </header>
      <section className="community-player-stage">
        {!game && !error ? <div className="community-state"><LoaderCircle className="spin" size={20} />Loading game</div> : null}
        {error ? (
          <div className="community-state community-error">
            <X size={20} />
            <span>{error}</span>
            <button className="quiet-button" type="button" onClick={() => void load()}>Retry</button>
          </div>
        ) : null}
        {game ? <iframe src={game.playUrl} title={game.title} sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts" /> : null}
      </section>
    </main>
  );
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
