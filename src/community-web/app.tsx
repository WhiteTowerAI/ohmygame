import { useEffect, useState, type ReactNode } from "react";
import { LoaderCircle, Play } from "../renderer/icons.js";
import type { PublishCommunityGame } from "../shared/publish-v1.js";
import { listCommunityGames } from "./api.js";
import appleIcon from "./assets/apple.svg";
import githubIcon from "./assets/github.svg";
import brandMark from "./assets/opengame-mark.svg";
import windowsIcon from "./assets/windows.svg";

const DOWNLOAD_URL = "https://github.com/WhiteTowerAI/open-game/releases/latest";
const GITHUB_URL = "https://github.com/WhiteTowerAI/open-game";
const FEATURED_GAME_LIMIT = 14;

export function App() {
  return <SiteShell><HomePage /></SiteShell>;
}

function SiteShell({ children }: { children: ReactNode }) {
  return <div className="site-shell">
    <SiteHeader />
    {children}
    <footer className="site-footer"><Brand /><span>Open-source tools for making and sharing games.</span><a href={GITHUB_URL}>GitHub</a></footer>
  </div>;
}

function SiteHeader() {
  return <header className="site-header">
    <a className="brand-link" href="/" aria-label="OpenGame home"><Brand /></a>
    <nav className="site-nav" aria-label="OpenGame"><a className="is-active" href="#games">Games</a><a className="api-link" href="https://portal.open-game.ai">API</a></nav>
    <div className="header-actions"><a className="github-link" href={GITHUB_URL} aria-label="OpenGame on GitHub" title="GitHub"><img src={githubIcon} alt="" /></a><a className="download-button" href={DOWNLOAD_URL}>Download</a></div>
  </header>;
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

  return <main>
    <section className="hero">
      <h1>THE FIRST OPEN-SOURCE PLATFORM FOR<br />GAME <em>CREATION</em>, <em>PUBLISHING</em>, AND <em>PLAY</em>.</h1>
      <div className="hero-actions"><a href={DOWNLOAD_URL}><img src={appleIcon} alt="" />Download for macOS</a><a href={DOWNLOAD_URL}><img src={windowsIcon} alt="" />Download for Windows</a></div>
    </section>
    <section className="featured-games content-width" id="games">
      <header className="section-heading"><h2>Games Built with OpenGame</h2><span>Play and explore</span></header>
      {loading ? <Status><LoaderCircle className="spin" size={18} />Loading games</Status> : null}
      {!loading && error ? <Status error={error} onRetry={loadGames} /> : null}
      {!loading && !error && games.length === 0 ? <Status>No published games yet</Status> : null}
      {!loading && !error && games.length > 0 ? <GameWall games={games.slice(0, FEATURED_GAME_LIMIT)} /> : null}
    </section>
  </main>;
}

function GameWall({ games }: { games: PublishCommunityGame[] }) {
  return <div className="game-wall">{games.map((game, index) => <article className={`game-tile game-tile-${index % 7}`} key={game.id}>
    <span className="game-preview"><iframe src={game.playUrl} title={game.title} loading="lazy" tabIndex={-1} sandbox="allow-scripts" /></span>
    <a className="game-link" href={game.playUrl} target="_blank" rel="noreferrer" aria-label={`Play ${game.title}`}><span className="game-overlay"><span><strong>{game.title}</strong><small>{publishedDate(game.publishedAt)}</small></span><Play size={17} /></span></a>
  </article>)}</div>;
}

function Status({ children, error, onRetry }: { children?: ReactNode; error?: string; onRetry?: () => void }) {
  return <div className={`status${error ? " status-error" : ""}`}>{children ?? error}{onRetry ? <button type="button" onClick={onRetry}>Try again</button> : null}</div>;
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }

function publishedDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)); }
