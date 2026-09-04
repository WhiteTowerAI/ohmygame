import { ArrowLeft, ExternalLink, LoaderCircle, Maximize, Play, RefreshCw, X } from "./icons.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import {
  GAME_DETAIL_MOSAIC_SLOTS,
  HOME_GAME_MOSAIC_SLOTS,
  takeGameMosaicSlots,
  type GameMosaicSlot,
} from "../shared/game-mosaic.js";
import brandMark from "../shared/assets/opengame-mark.svg";
import { getExploreGame, getExploreGameCover, listExploreGames, waitForRuntime } from "./api.js";
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
          <GameMosaic games={games.slice(0, HOME_GAME_MOSAIC_SLOTS.length)} onOpenGame={onOpenGame} />
        ) : null}
      </section>
    </SidebarPageLayout>
  );
}

type MosaicStyle = CSSProperties & {
  "--mosaic-column": number;
  "--mosaic-row": number;
  "--mosaic-size": number;
};

function GameMosaic({ games, onOpenGame }: { games: CommunityGame[]; onOpenGame: (gameId: string) => void }) {
  const slots = takeGameMosaicSlots(HOME_GAME_MOSAIC_SLOTS, games.length);
  const complete = games.length === HOME_GAME_MOSAIC_SLOTS.length;
  return (
    <div className={`explore-game-mosaic${complete ? " is-complete" : ""}`}>
      {games.map((game, index) => (
        <GameTile
          game={game}
          key={game.id}
          onOpen={() => onOpenGame(game.id)}
          slot={slots[index]!}
          useFixedSlot={complete}
        />
      ))}
    </div>
  );
}

function GameTile({ className = "", game, onOpen, slot, useFixedSlot }: {
  className?: string;
  game: CommunityGame;
  onOpen: () => void;
  slot: GameMosaicSlot;
  useFixedSlot: boolean;
}) {
  const coverUrl = useGameCover(game);
  const style: MosaicStyle = {
    "--mosaic-column": slot.column,
    "--mosaic-row": slot.row,
    "--mosaic-size": slot.size,
  };
  return (
    <article className={`explore-game-tile explore-game-tile-size-${slot.size}${className ? ` ${className}` : ""}`} style={useFixedSlot ? style : undefined}>
      {coverUrl
        ? <img className="explore-game-cover" src={coverUrl} alt="" />
        : <span className="explore-game-cover-placeholder" aria-hidden="true"><img src={brandMark} alt="" /></span>}
      <button type="button" onClick={onOpen} aria-label={`Play ${game.title}`}>
        <span className="explore-game-overlay">
          <span><strong>{game.title}</strong><small>{publishedDate(game.publishedAt)}</small></span>
          <Play size={17} />
        </span>
      </button>
    </article>
  );
}

function useGameCover(game: CommunityGame): string | undefined {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    if (!game.coverUrl) return;
    void getExploreGameCover(game.id, game.deploymentId)
      .then((cover) => {
        if (!active || !cover) return;
        objectUrl = URL.createObjectURL(cover);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [game.coverUrl, game.deploymentId, game.id]);

  return url;
}

export function GamePlayer({ gameId, onBack, onOpenGame }: {
  gameId: string;
  onBack: () => void;
  onOpenGame: (gameId: string) => void;
}) {
  const [game, setGame] = useState<CommunityGame>();
  const [relatedGames, setRelatedGames] = useState<CommunityGame[]>([]);
  const [error, setError] = useState<string>();
  const loadVersion = useRef(0);

  async function load() {
    const version = ++loadVersion.current;
    setGame(undefined);
    setRelatedGames([]);
    setError(undefined);
    try {
      await waitForRuntime();
      const [currentGame, games] = await Promise.all([
        getExploreGame(gameId),
        listExploreGames().catch(() => []),
      ]);
      if (version !== loadVersion.current) return;
      setGame(currentGame);
      setRelatedGames(games.filter((candidate) => candidate.id !== gameId).slice(0, GAME_DETAIL_MOSAIC_SLOTS.length));
    } catch (cause) {
      if (version !== loadVersion.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void load();
    return () => { loadVersion.current += 1; };
  }, [gameId]);

  return (
    <main className="game-detail-page">
      <header className="game-detail-page-header window-drag-handle">
        <button className="game-player-back" type="button" onClick={onBack}>
          <ArrowLeft size={15} />
          Games
        </button>
        {game ? <span aria-hidden="true">/</span> : null}
        {game ? <strong title={game.title}>{game.title}</strong> : null}
      </header>
      <section className="game-detail-scroll">
        {!game && !error ? <div className="explore-state"><LoaderCircle className="spin" size={20} />Loading game</div> : null}
        {error ? (
          <div className="explore-state explore-error">
            <X size={20} />
            <span>{error}</span>
            <button className="quiet-button" type="button" onClick={() => void load()}>Retry</button>
          </div>
        ) : null}
        {game ? <GameDetail game={game} relatedGames={relatedGames} onOpenGame={onOpenGame} /> : null}
      </section>
    </main>
  );
}

function GameDetail({ game, relatedGames, onOpenGame }: {
  game: CommunityGame;
  relatedGames: CommunityGame[];
  onOpenGame: (gameId: string) => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const slots = takeGameMosaicSlots(GAME_DETAIL_MOSAIC_SLOTS, relatedGames.length);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerRef.current?.requestFullscreen();
  }

  return (
    <div className="electron-game-detail-content">
      <div className={`electron-game-detail-mosaic${relatedGames.length ? " has-related-games" : ""}`}>
        <div className="electron-game-player" ref={playerRef}>
          <div className="electron-game-stage">
            <iframe
              src={game.playUrl}
              title={game.title}
              sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
              allow="autoplay; fullscreen"
            />
          </div>
          <div className="electron-game-toolbar">
            <div><strong>{game.title}</strong><span>Made with OpenGame</span></div>
            <div className="electron-game-toolbar-actions">
              <button type="button" onClick={() => void toggleFullscreen()} title="Fullscreen" aria-label="Fullscreen"><Maximize size={17} /></button>
            </div>
          </div>
        </div>

        <article className="electron-game-information">
          <span className="electron-game-detail-label">GAME INFO</span>
          <h1>{game.title}</h1>
          {game.description ? <p>{game.description}</p> : null}
          <dl><dt>RELEASED</dt><dd>{publishedDate(game.publishedAt)}</dd></dl>
        </article>

        <aside className="electron-game-open-panel">
          <span className="electron-game-detail-label">PLAY ANYWHERE</span>
          <h2>OPEN IN YOUR BROWSER</h2>
          <button type="button" onClick={() => void openExternal(game.playUrl)}>Open game<ExternalLink size={15} /></button>
        </aside>

        {relatedGames.length ? (
          <section className="electron-game-related" aria-label="More games">
            <h2>More games</h2>
            {relatedGames.map((relatedGame, index) => (
              <GameTile
                className="electron-game-related-tile"
                game={relatedGame}
                key={relatedGame.id}
                onOpen={() => onOpenGame(relatedGame.id)}
                slot={slots[index]!}
                useFixedSlot
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

async function openExternal(url: string): Promise<void> {
  if (window.openGameDesktop) await window.openGameDesktop.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
