import { ArrowLeft, Gamepad2, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { PublishCommunityGame } from "../shared/publish-v1.js";
import { getCommunityGame, listCommunityGames } from "./api.js";

export type CommunityRoute = { page: "list" } | { page: "game"; gameId: string };

export function parseCommunityRoute(pathname: string): CommunityRoute {
  const match = /^\/games\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return { page: "list" };
  try {
    return { page: "game", gameId: decodeURIComponent(match[1]) };
  } catch {
    return { page: "list" };
  }
}

export function App() {
  const route = parseCommunityRoute(window.location.pathname);
  return route.page === "game" ? <GamePage gameId={route.gameId} /> : <GameList />;
}

function GameList() {
  const [games, setGames] = useState<PublishCommunityGame[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      setGames(await listCommunityGames());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <Page>
      <header className="page-heading">
        <div>
          <span className="eyebrow">OpenGame</span>
          <h1>Community</h1>
        </div>
        <button className="icon-button" type="button" onClick={() => void load()} aria-label="Refresh games" title="Refresh games">
          <RefreshCw className={loading ? "spin" : undefined} size={17} />
        </button>
      </header>

      {loading ? <Status><LoaderCircle className="spin" size={20} />Loading games</Status> : null}
      {!loading && error ? <Status error={error} onRetry={load} /> : null}
      {!loading && !error && games.length === 0 ? <Status>No published games yet</Status> : null}
      {!loading && !error && games.length > 0 ? (
        <div className="game-grid">
          {games.map((game) => (
            <a className="game-card" href={`/games/${encodeURIComponent(game.id)}`} key={game.id}>
              <span className="game-art"><Gamepad2 size={30} /></span>
              <span className="game-copy">
                <strong>{game.title}</strong>
                <span>{game.description || "Play this community game"}</span>
                <time dateTime={game.publishedAt}>{publishedDate(game.publishedAt)}</time>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </Page>
  );
}

function GamePage({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<PublishCommunityGame>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void getCommunityGame(gameId)
      .then((loaded) => { if (active) setGame(loaded); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [gameId]);

  return (
    <main className="player-page">
      <header className="player-header">
        <a className="icon-button" href="/" aria-label="Back to Community" title="Back to Community"><ArrowLeft size={17} /></a>
        <div>
          <strong>{game?.title ?? "Community game"}</strong>
          {game?.description ? <span>{game.description}</span> : null}
        </div>
      </header>
      {error ? <Status error={error} /> : null}
      {!game && !error ? <Status><LoaderCircle className="spin" size={20} />Loading game</Status> : null}
      {game ? (
        <iframe
          src={game.playUrl}
          title={game.title}
          sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
          allow="autoplay; fullscreen"
        />
      ) : null}
    </main>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <main className="community-page"><div className="page-content">{children}</div></main>;
}

function Status({ children, error, onRetry }: { children?: React.ReactNode; error?: string; onRetry?: () => void }) {
  return (
    <div className={`status${error ? " status-error" : ""}`}>
      {children ?? error}
      {onRetry ? <button type="button" onClick={() => void onRetry()}>Try again</button> : null}
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
