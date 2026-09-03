import { ArrowLeft, ExternalLink, Gamepad2, LoaderCircle, RefreshCw, X } from "./icons.js";
import { useEffect, useState } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import { getExploreGame, listExploreGames, waitForRuntime } from "./api.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";

export function GamesPage({
  onNavigate,
  onOpenGame,
}: {
  onNavigate: (page: AppNavigationTarget) => void;
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
      setGames(await listExploreGames());
      setPhase("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <SidebarPageLayout active="games" onNavigate={onNavigate}>
      <SidebarPageHeader
        title="Games"
        actions={(
          <button className="icon-button quiet-button" type="button" onClick={() => void load()} title="Refresh" aria-label="Refresh">
            <RefreshCw className={phase === "loading" ? "spin" : undefined} size={15} />
          </button>
        )}
      />

      <section className="explore-content">
        {phase === "loading" ? <div className="explore-state"><LoaderCircle className="spin" size={20} />Loading games</div> : null}
        {phase === "error" ? <div className="explore-state explore-error"><X size={20} />{error}</div> : null}
        {phase === "ready" && games.length === 0 ? <div className="explore-state">No published games yet</div> : null}
        {phase === "ready" && games.length > 0 ? (
          <div className="home-project-grid">
            {games.map((game, index) => (
              <article className="explore-game-card" key={game.id}>
                <button className="explore-game-card-open" type="button" onClick={() => onOpenGame(game.id)} aria-label={`Play ${game.title}`}>
                  <span className={`explore-game-card-preview project-card-preview-${index % 4} explore-game-preview`} aria-hidden="true">
                    <Gamepad2 size={28} />
                  </span>
                  <span className="explore-game-card-meta">
                    <span className="home-project-avatar" aria-hidden="true"><Gamepad2 size={14} /></span>
                    <span className="explore-game-card-copy">
                      <span className="explore-game-card-name" title={game.title}>{game.title}</span>
                      <span className="explore-game-card-time">{publishedTime(game.publishedAt)}</span>
                    </span>
                  </span>
                </button>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </SidebarPageLayout>
  );
}

export function GamePlayer({ gameId, onBack }: { gameId: string; onBack: () => void }) {
  const [game, setGame] = useState<CommunityGame>();
  const [error, setError] = useState<string>();

  async function load() {
    setGame(undefined);
    setError(undefined);
    try {
      await waitForRuntime();
      setGame(await getExploreGame(gameId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => { void load(); }, [gameId]);

  return (
    <main className="game-player-page">
      <header className="game-player-header window-drag-handle">
        <button className="game-player-back" type="button" onClick={onBack}>
          <ArrowLeft size={15} />
          Games
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
      <section className="game-player-stage">
        {!game && !error ? <div className="explore-state"><LoaderCircle className="spin" size={20} />Loading game</div> : null}
        {error ? (
          <div className="explore-state explore-error">
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

function publishedTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "Published just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Published ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Published ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Published ${days}d ago`;
}
