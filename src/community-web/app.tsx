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

type MosaicSlot = { column: number; row: number; size: 1 | 2 | 3 };
type MosaicStyle = CSSProperties & {
  "--mosaic-column": number;
  "--mosaic-row": number;
  "--mosaic-size": number;
};

const HOME_MOSAIC_SLOTS: readonly MosaicSlot[] = [
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

const GAME_DETAIL_SLOTS: readonly MosaicSlot[] = [
  { column: 8, row: 1, size: 1 },
  { column: 8, row: 2, size: 1 },
  { column: 8, row: 3, size: 1 },
  { column: 8, row: 4, size: 1 },
  { column: 8, row: 5, size: 1 },
  { column: 6, row: 6, size: 2 },
  { column: 8, row: 6, size: 1 },
  { column: 8, row: 7, size: 1 },
  { column: 6, row: 8, size: 3 },
  { column: 1, row: 9, size: 2 },
  { column: 3, row: 9, size: 1 },
  { column: 3, row: 10, size: 1 },
  { column: 4, row: 8, size: 2 },
  { column: 1, row: 11, size: 3 },
  { column: 4, row: 11, size: 2 },
  { column: 7, row: 11, size: 2 },
  { column: 6, row: 11, size: 1 },
  { column: 6, row: 12, size: 1 },
  { column: 4, row: 13, size: 1 },
  { column: 5, row: 13, size: 1 },
  { column: 6, row: 13, size: 1 },
  { column: 7, row: 13, size: 1 },
  { column: 8, row: 13, size: 1 },
  { column: 1, row: 14, size: 1 },
  { column: 2, row: 14, size: 1 },
  { column: 3, row: 14, size: 2 },
  { column: 5, row: 14, size: 1 },
  { column: 6, row: 14, size: 2 },
];

export function getGameMosaicSlots(count: number): readonly MosaicSlot[] {
  return takeMosaicSlots(HOME_MOSAIC_SLOTS, count);
}

export function getGameDetailMosaicSlots(count: number): readonly MosaicSlot[] {
  return takeMosaicSlots(GAME_DETAIL_SLOTS, count);
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
        {!loading && !error && games.length > 0 ? <GameWall games={games.slice(0, HOME_MOSAIC_SLOTS.length)} /> : null}
      </section>
    </main>
  );
}

function GameWall({ games }: { games: PublishCommunityGame[] }) {
  const slots = getGameMosaicSlots(games.length);
  const complete = games.length === HOME_MOSAIC_SLOTS.length;
  return (
    <div className={`game-wall${complete ? " game-wall-complete" : ""}`}>
      {games.map((game, index) => (
        <GameTile
          className={`game-tile-size-${slots[index]?.size ?? 1}`}
          game={game}
          key={game.id}
          style={complete ? mosaicStyle(slots[index]!) : undefined}
        />
      ))}
    </div>
  );
}

function GameTile({ game, className, style }: { game: PublishCommunityGame; className: string; style?: CSSProperties }) {
  return (
    <article className={`game-tile ${className}`} style={style}>
      <GameCover game={game} />
      <a className="game-link" href={`/games/${encodeURIComponent(game.id)}`} aria-label={`View ${game.title}`}>
        <span className="game-overlay"><span><strong>{game.title}</strong><small>{publishedDate(game.publishedAt)}</small></span><Play size={17} /></span>
      </a>
    </article>
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
  const [relatedGames, setRelatedGames] = useState<PublishCommunityGame[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setGame(undefined);
    setRelatedGames([]);
    setError(undefined);
    void Promise.all([
      getCommunityGame(gameId),
      listCommunityGames().catch(() => []),
    ])
      .then(([value, games]) => {
        if (!active) return;
        setRelatedGames(games.filter((candidate) => candidate.id !== gameId).slice(0, GAME_DETAIL_SLOTS.length));
        setGame(value);
      })
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
  return <GameDetail game={game} relatedGames={relatedGames} />;
}

function GameDetail({ game, relatedGames }: { game: PublishCommunityGame; relatedGames: PublishCommunityGame[] }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [shared, setShared] = useState(false);
  const relatedSlots = getGameDetailMosaicSlots(relatedGames.length);

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
      <div className={`game-detail-mosaic${relatedGames.length ? " has-related-games" : ""}`}>
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
        {relatedGames.length ? (
          <div className="detail-related-games">
            <h2>More games</h2>
            {relatedGames.map((relatedGame, index) => (
              <GameTile
                className={`detail-related-tile game-tile-size-${relatedSlots[index]?.size ?? 1}`}
                game={relatedGame}
                key={relatedGame.id}
                style={mosaicStyle(relatedSlots[index]!)}
              />
            ))}
          </div>
        ) : null}
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

function mosaicStyle(slot: MosaicSlot): MosaicStyle {
  return {
    "--mosaic-column": slot.column,
    "--mosaic-row": slot.row,
    "--mosaic-size": slot.size,
  };
}

function takeMosaicSlots(slots: readonly MosaicSlot[], count: number): readonly MosaicSlot[] {
  return slots.slice(0, Math.max(0, Math.min(Math.floor(count), slots.length)));
}
