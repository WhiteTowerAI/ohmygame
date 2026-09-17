import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LoaderCircle } from "../renderer/icons.js";
import {
  HOME_GAME_MOSAIC_SLOTS,
  takeGameMosaicSlots,
  type GameMosaicSlot,
} from "../shared/game-mosaic.js";
import type { PublishCommunityGame } from "../shared/publish-v1.js";
import { getCommunityGame, listCommunityGames } from "./api.js";
import { WebAccountPage } from "./account.js";
import type { AccountSection } from "../account-ui/account-page.js";
import appleIcon from "./assets/apple.svg";
import fullscreenIcon from "./assets/fullscreen.svg";
import githubIcon from "./assets/github.svg";
import brandMark from "../shared/assets/opengame-mark.svg";
import shareIcon from "./assets/share.svg";
import windowsIcon from "./assets/windows.svg";

const DOWNLOAD_URL = "https://github.com/WhiteTowerAI/open-game/releases/latest";
const GITHUB_URL = "https://github.com/WhiteTowerAI/open-game";
const RELATED_GAMES_LIMIT = 10;

type MosaicStyle = CSSProperties & {
  "--mosaic-column": number;
  "--mosaic-row": number;
  "--mosaic-size": number;
};

export function getGameMosaicSlots(count: number): readonly GameMosaicSlot[] {
  return takeGameMosaicSlots(HOME_GAME_MOSAIC_SLOTS, count);
}

export type CommunityRoute =
  | { page: "home" }
  | { page: "game"; gameId: string }
  | { page: "account"; section: AccountSection }
  | { page: "not-found" };

export function parseCommunityRoute(pathname: string): CommunityRoute {
  if (pathname === "/" || pathname === "") return { page: "home" };
  const path = pathname.replace(/\/$/, "");
  if (["/pricing", "/plans"].includes(path)) return { page: "account", section: "plans" };
  if (["/account", "/account/billing", "/billing"].includes(path)) return { page: "account", section: "billing" };
  if (["/account/usage", "/usage"].includes(path)) return { page: "account", section: "usage" };
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
      {route.page === "account" ? <WebAccountPage section={route.section} /> : null}
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
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  return (
    <header className="site-header">
      <a className="brand-link" href="/" aria-label="OpenGame home"><Brand /></a>
      <nav className="site-nav" aria-label="OpenGame">
        <a className={pathname === "/" || pathname.startsWith("/games/") ? "is-active" : undefined} href="/#games">Games</a>
        <a className={pathname === "/pricing" || pathname === "/plans" ? "is-active" : undefined} href="/pricing">Pricing</a>
        <a className={pathname.startsWith("/account") || pathname === "/usage" || pathname === "/billing" ? "is-active" : undefined} href="/account/usage">Account</a>
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
        {!loading && !error && games.length > 0 ? <GameWall games={games.slice(0, HOME_GAME_MOSAIC_SLOTS.length)} /> : null}
      </section>
    </main>
  );
}

function GameWall({ games }: { games: PublishCommunityGame[] }) {
  const slots = getGameMosaicSlots(games.length);
  const complete = games.length === HOME_GAME_MOSAIC_SLOTS.length;
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
        <span className="game-overlay">
          <span className="game-overlay-copy">
            <strong>{game.title}</strong>
            <span className="game-creator">
              <span className="game-creator-avatar" aria-hidden="true">
                <i>{game.author.displayName.slice(0, 1).toUpperCase()}</i>
                {game.author.avatarUrl ? <img src={game.author.avatarUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
              </span>
              <small>{game.author.displayName}</small>
            </span>
          </span>
        </span>
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

function GameThumbnail({ game }: { game: PublishCommunityGame }) {
  const [failed, setFailed] = useState(false);
  const source = `/v1/community/games/${encodeURIComponent(game.id)}/deployments/${encodeURIComponent(game.deploymentId)}/cover`;
  return <span className="player-thumbnail" aria-hidden="true">
    {game.coverUrl && !failed ? <img src={source} alt="" onError={() => setFailed(true)} /> : <img className="is-placeholder" src={brandMark} alt="" />}
  </span>;
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
        setRelatedGames(games.filter((candidate) => candidate.id !== gameId).slice(0, RELATED_GAMES_LIMIT));
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
      <div className="game-detail-content">
        <div className="game-player" ref={playerRef}>
          <div className="game-stage"><iframe src={game.playUrl} title={game.title} sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts" allow="autoplay; fullscreen" /></div>
          <div className="player-toolbar">
            <div className="player-summary"><GameThumbnail game={game} /><div className="player-identity"><strong>{game.title}</strong><span>by {game.author.displayName} · {game.stats.uses} {game.stats.uses === 1 ? "player" : "players"} · {publishedDate(game.publishedAt)}</span>{game.description ? <p>{game.description}</p> : null}</div></div>
            <div className="player-actions">
              <button type="button" onClick={() => void shareGame()} aria-label="Share game" title={shared ? "Link copied" : "Share game"}><img src={shareIcon} alt="" /></button>
              <button type="button" onClick={() => void toggleFullscreen()} aria-label="Toggle fullscreen" title="Fullscreen"><img src={fullscreenIcon} alt="" /></button>
            </div>
          </div>
        </div>
        {relatedGames.length ? <section className="detail-related-games" aria-label="More games"><h2>More games</h2><div className="detail-related-grid">{relatedGames.map((relatedGame) => <GameTile className="detail-related-tile" game={relatedGame} key={relatedGame.id} />)}</div></section> : null}
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

function mosaicStyle(slot: GameMosaicSlot): MosaicStyle {
  return {
    "--mosaic-column": slot.column,
    "--mosaic-row": slot.row,
    "--mosaic-size": slot.size,
  };
}
