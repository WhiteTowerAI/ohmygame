import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LoaderCircle, Play } from "../renderer/icons.js";
import type { PublishCommunityGame } from "../shared/publish-v1.js";
import { getCommunityGame, listCommunityGames } from "./api.js";
import appleIcon from "./assets/apple.svg";
import fullscreenIcon from "./assets/fullscreen.svg";
import githubIcon from "./assets/github.svg";
import brandMark from "./assets/opengame-mark.svg";
import shareIcon from "./assets/share.svg";
import windowsIcon from "./assets/windows.svg";

const DOWNLOAD_URL = "https://github.com/WhiteTowerAI/open-game/releases/latest";
const GITHUB_URL = "https://github.com/WhiteTowerAI/open-game";
const FEATURED_GAME_LIMIT = 28;

type MosaicSlot = { column: number; row: number; size: 1 | 2 | 3 };

const MOSAIC_SLOTS: readonly MosaicSlot[] = [
  { column: 1, row: 1, size: 3 },
  { column: 4, row: 1, size: 2 },
  { column: 6, row: 1, size: 2 },
  { column: 8, row: 1, size: 1 },
  { column: 8, row: 2, size: 1 },
  { column: 4, row: 3, size: 1 },
  { column: 5, row: 3, size: 2 },
  { column: 7, row: 3, size: 2 },
  { column: 1, row: 4, size: 1 },
  { column: 2, row: 4, size: 1 },
  { column: 3, row: 4, size: 2 },
  { column: 1, row: 5, size: 2 },
  { column: 5, row: 5, size: 1 },
  { column: 6, row: 5, size: 3 },
  { column: 3, row: 6, size: 1 },
  { column: 4, row: 6, size: 2 },
  { column: 1, row: 7, size: 2 },
  { column: 3, row: 7, size: 1 },
  { column: 3, row: 8, size: 2 },
  { column: 5, row: 8, size: 1 },
  { column: 6, row: 8, size: 1 },
  { column: 7, row: 8, size: 2 },
  { column: 1, row: 9, size: 2 },
  { column: 5, row: 9, size: 2 },
  { column: 3, row: 10, size: 1 },
  { column: 4, row: 10, size: 1 },
  { column: 7, row: 10, size: 1 },
  { column: 8, row: 10, size: 1 },
];

export function getGameMosaicSlots(count: number): readonly MosaicSlot[] {
  return MOSAIC_SLOTS.slice(0, Math.max(0, Math.min(Math.floor(count), MOSAIC_SLOTS.length)));
}

export type CommunityRoute =
  | { page: "home" }
  | { page: "game"; gameId: string }
  | { page: "not-found" };

export function parseCommunityRoute(pathname: string): CommunityRoute {
  if (pathname === "/" || pathname === "") return { page: "home" };
  const match = /^\/games\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return { page: "not-found" };
  try {
    return { page: "game", gameId: decodeURIComponent(match[1]) };
  } catch {
    return { page: "not-found" };
  }
}

export function App() {
  const route = parseCommunityRoute(window.location.pathname);
  return (
    <SiteShell>
      {route.page === "home" ? <HomePage /> : null}
      {route.page === "game" ? <GamePage gameId={route.gameId} /> : null}
      {route.page === "not-found" ? <NotFound /> : null}
    </SiteShell>
  );
}

function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="site-shell">
      <SiteHeader />
      {children}
      <footer className="site-footer">
        <Brand />
        <span>Open-source tools for making and sharing games.</span>
        <a href={GITHUB_URL}>GitHub</a>
      </footer>
    </div>
  );
}

function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand-link" href="/" aria-label="OpenGame home"><Brand /></a>
      <nav className="site-nav" aria-label="OpenGame">
        <a className="is-active" href="/#games">Games</a>
        <a className="api-link" href="https://portal.open-game.ai">API</a>
      </nav>
      <div className="header-actions">
        <a className="github-link" href={GITHUB_URL} aria-label="OpenGame on GitHub" title="GitHub"><img src={githubIcon} alt="" /></a>
        <a className="download-button" href={DOWNLOAD_URL}>Download</a>
      </div>
    </header>
  );
}

function Brand() {
  return <span className="brand"><img src={brandMark} alt="" /><span>OPEN<span>GAME</span></span></span>;
}

function HomePage() {
  const [games, setGames] = useState<PublishCommunityGame[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);

  async function loadGames() {
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

  useEffect(() => { void loadGames(); }, []);

  return (
    <main>
      <section className="hero">
        <h1>THE FIRST OPEN-SOURCE PLATFORM FOR<br />GAME <em>CREATION</em>, <em>PUBLISHING</em>, AND <em>PLAY</em>.</h1>
        <div className="hero-actions">
          <a href={DOWNLOAD_URL}><img src={appleIcon} alt="" />Download for macOS</a>
          <a href={DOWNLOAD_URL}><img src={windowsIcon} alt="" />Download for Windows</a>
        </div>
      </section>
      <section className="featured-games content-width" id="games">
        <header className="section-heading"><h2>Games Built with OpenGame</h2><span>Play and explore</span></header>
        {loading ? <Status><LoaderCircle className="spin" size={18} />Loading games</Status> : null}
        {!loading && error ? <Status error={error} onRetry={loadGames} /> : null}
        {!loading && !error && games.length === 0 ? <Status>No published games yet</Status> : null}
        {!loading && !error && games.length > 0 ? <GameWall games={games.slice(0, FEATURED_GAME_LIMIT)} /> : null}
      </section>
    </main>
  );
}

function GameWall({ games }: { games: PublishCommunityGame[] }) {
  const slots = getGameMosaicSlots(games.length);
  const complete = games.length === MOSAIC_SLOTS.length;
  return (
    <div className={`game-wall${complete ? " game-wall-complete" : ""}`}>
      {games.map((game, index) => (
        <article
          className={`game-tile game-tile-size-${slots[index]?.size ?? 1}`}
          key={game.id}
          style={complete ? {
            "--mosaic-column": slots[index]?.column,
            "--mosaic-row": slots[index]?.row,
            "--mosaic-size": slots[index]?.size,
          } as CSSProperties : undefined}
        >
          <GameCover game={game} />
          <a className="game-link" href={`/games/${encodeURIComponent(game.id)}`} aria-label={`View ${game.title}`}>
            <span className="game-overlay"><span><strong>{game.title}</strong><small>{publishedDate(game.publishedAt)}</small></span><Play size={17} /></span>
          </a>
        </article>
      ))}
    </div>
  );
}

function GameCover({ game }: { game: PublishCommunityGame }) {
  const [failed, setFailed] = useState(false);
  if (!game.coverUrl || failed) {
    return <span className="game-preview game-cover-placeholder" aria-hidden="true"><img src={brandMark} alt="" /></span>;
  }
  const source = `/v1/community/games/${encodeURIComponent(game.id)}/deployments/${encodeURIComponent(game.deploymentId)}/cover`;
  return <span className="game-preview"><img className="game-cover" src={source} alt="" loading="lazy" onError={() => setFailed(true)} /></span>;
}

function GamePage({ gameId }: { gameId: string }) {
  const [game, setGame] = useState<PublishCommunityGame>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void getCommunityGame(gameId)
      .then((value) => { if (active) setGame(value); })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [gameId]);

  useEffect(() => {
    if (!game) return;
    document.title = `${game.title} | OpenGame`;
    return () => { document.title = "OpenGame"; };
  }, [game]);

  if (error) return <main className="game-detail content-width"><Status error={error} /></main>;
  if (!game) return <main className="game-detail content-width"><Status><LoaderCircle className="spin" size={18} />Loading game</Status></main>;
  return <GameDetail game={game} />;
}

function GameDetail({ game }: { game: PublishCommunityGame }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [shared, setShared] = useState(false);

  async function shareGame() {
    const data = { title: game.title, text: game.description, url: window.location.href };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(data.url);
        setShared(true);
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) console.error(cause);
    }
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerRef.current?.requestFullscreen();
  }

  return (
    <main className="game-detail content-width">
      <div className="game-player" ref={playerRef}>
        <div className="game-stage"><iframe src={game.playUrl} title={game.title} sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts" allow="autoplay; fullscreen" /></div>
        <div className="player-toolbar">
          <div className="player-identity"><strong>{game.title}</strong><span>Made with OpenGame</span></div>
          <div className="player-actions">
            <button type="button" onClick={() => void shareGame()} aria-label="Share game" title={shared ? "Link copied" : "Share game"}><img src={shareIcon} alt="" /></button>
            <button type="button" onClick={() => void toggleFullscreen()} aria-label="Toggle fullscreen" title="Fullscreen"><img src={fullscreenIcon} alt="" /></button>
          </div>
        </div>
      </div>
      <div className="game-detail-grid">
        <article className="game-information">
          <span className="detail-label">GAME INFO</span>
          <h1>{game.title}</h1>
          {game.description ? <p>{game.description}</p> : null}
          <dl><dt>RELEASED</dt><dd>{publishedDate(game.publishedAt)}</dd></dl>
        </article>
        <aside className="download-cta">
          <span className="detail-label">YOUR TURN</span>
          <h2>MAKE A GAME<br />OF YOUR OWN.</h2>
          <p>Create, play, and publish with OpenGame. Your next world starts here.</p>
          <a href={DOWNLOAD_URL}>Download OpenGame</a>
        </aside>
      </div>
    </main>
  );
}

function NotFound() {
  return <main className="not-found content-width"><h1>GAME NOT FOUND</h1><p>This game may have moved or is no longer available.</p><a href="/">Back to OpenGame</a></main>;
}

function Status({ children, error, onRetry }: { children?: ReactNode; error?: string; onRetry?: () => void }) {
  return <div className={`status${error ? " status-error" : ""}`}>{children ?? error}{onRetry ? <button type="button" onClick={onRetry}>Try again</button> : null}</div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
