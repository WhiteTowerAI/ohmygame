import { Check, Copy, LoaderCircle, Maximize, RefreshCw, Share2, X } from "./icons.js";
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import {
  HOME_GAME_MOSAIC_SLOTS,
  takeGameMosaicSlots,
  type GameMosaicSlot,
} from "../shared/game-mosaic.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";
import { getExploreGame, getExploreGameCover, listExploreGames, waitForRuntime } from "./api.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";

const RELATED_GAMES_LIMIT = 10;

export function GamesPage({
  onNavigate,
  onOhMyGame,
}: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOhMyGame: (gameId: string) => void;
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
    <SidebarPageLayout active="community" onNavigate={onNavigate}>
      <SidebarPageHeader title="Community" actions={(
        <button className="projects-icon-button" type="button" onClick={() => void load()} disabled={phase === "loading"} title="Refresh" aria-label="Refresh">
          <RefreshCw className={phase === "loading" ? "spin" : undefined} size={15} />
        </button>
      )} />

      <section className="explore-content">
        {phase === "loading" ? <div className="explore-state"><LoaderCircle className="spin" size={20} />Loading games</div> : null}
        {phase === "error" ? <div className="explore-state explore-error"><X size={20} />{error}</div> : null}
        {phase === "ready" && games.length === 0 ? <div className="explore-state">No published games yet</div> : null}
        {phase === "ready" && games.length > 0 ? (
          <GameMosaic games={games.slice(0, HOME_GAME_MOSAIC_SLOTS.length)} onOhMyGame={onOhMyGame} />
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

function GameMosaic({ games, onOhMyGame }: { games: CommunityGame[]; onOhMyGame: (gameId: string) => void }) {
  const slots = takeGameMosaicSlots(HOME_GAME_MOSAIC_SLOTS, games.length);
  const complete = games.length === HOME_GAME_MOSAIC_SLOTS.length;
  return (
    <div className={`explore-game-mosaic${complete ? " is-complete" : ""}`}>
      {games.map((game, index) => (
        <GameTile
          game={game}
          key={game.id}
          onOpen={() => onOhMyGame(game.id)}
          slot={slots[index]!}
          useFixedSlot={complete}
        />
      ))}
    </div>
  );
}

function GameTile({ className = "", game, onOpen, slot, useFixedSlot = false }: {
  className?: string;
  game: CommunityGame;
  onOpen: () => void;
  slot?: GameMosaicSlot;
  useFixedSlot?: boolean;
}) {
  const coverUrl = useGameCover(game);
  const size = slot?.size ?? 1;
  const style: MosaicStyle | undefined = slot ? {
    "--mosaic-column": slot.column,
    "--mosaic-row": slot.row,
    "--mosaic-size": slot.size,
  } : undefined;
  return (
    <article className={`explore-game-tile explore-game-tile-size-${size}${className ? ` ${className}` : ""}`} style={useFixedSlot ? style : undefined}>
      {coverUrl
        ? <img className="explore-game-cover" src={coverUrl} alt="" />
        : <span className="explore-game-cover-placeholder" aria-hidden="true"><img src={brandMark} alt="" /></span>}
      <button type="button" onClick={onOpen} aria-label={`Play ${game.title}`}>
        <span className="explore-game-overlay">
          <span className="explore-game-overlay-copy">
            <strong>{game.title}</strong>
            <span className="explore-game-creator">
              <span className="explore-game-creator-avatar" aria-hidden="true">
                <i>{game.author.displayName.slice(0, 1).toUpperCase()}</i>
                {game.author.avatarUrl ? <img src={game.author.avatarUrl} alt="" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
              </span>
              <small>{game.author.displayName}</small>
            </span>
          </span>
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

export function GamePlayer({ gameId, onBack, onNavigate, onOhMyGame }: {
  gameId: string;
  onBack: () => void;
  onNavigate: (page: AppNavigationTarget) => void;
  onOhMyGame: (gameId: string) => void;
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
      setRelatedGames(games.filter((candidate) => candidate.id !== gameId).slice(0, RELATED_GAMES_LIMIT));
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
    <SidebarPageLayout active="community" onNavigate={onNavigate}>
      <SidebarPageHeader title={game?.title ?? "Game"} breadcrumb={{ label: "Games", onClick: onBack }} />
      <section className="game-detail-scroll">
        {!game && !error ? <div className="explore-state"><LoaderCircle className="spin" size={20} />Loading game</div> : null}
        {error ? (
          <div className="explore-state explore-error">
            <X size={20} />
            <span>{error}</span>
            <button className="quiet-button" type="button" onClick={() => void load()}>Retry</button>
          </div>
        ) : null}
        {game ? <GameDetail key={game.id} game={game} relatedGames={relatedGames} onOhMyGame={onOhMyGame} /> : null}
      </section>
    </SidebarPageLayout>
  );
}

function GameDetail({ game, relatedGames, onOhMyGame }: {
  game: CommunityGame;
  relatedGames: CommunityGame[];
  onOhMyGame: (gameId: string) => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const coverUrl = useGameCover(game);
  const [sharing, setSharing] = useState(false);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerRef.current?.requestFullscreen();
  }

  return (
    <div className="electron-game-detail-content">
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
          <div className="electron-game-summary">
            <span className="electron-game-thumbnail" aria-hidden="true">{coverUrl ? <img src={coverUrl} alt="" /> : <img className="is-placeholder" src={brandMark} alt="" />}</span>
            <div className="electron-game-identity">
              <strong>{game.title}</strong>
              <span>by {game.author.displayName} · {publishedDate(game.publishedAt)}</span>
              {game.description ? <p>{game.description}</p> : null}
            </div>
          </div>
          <div className="electron-game-toolbar-actions">
            <button type="button" onClick={() => setSharing(true)} title="Share game" aria-label="Share game" aria-haspopup="dialog"><Share2 size={17} /></button>
            <button type="button" onClick={() => void toggleFullscreen()} title="Fullscreen" aria-label="Fullscreen"><Maximize size={17} /></button>
          </div>
        </div>
      </div>

      {sharing ? <GameShareDialog game={game} onClose={() => setSharing(false)} /> : null}

      {relatedGames.length ? (
        <section className="electron-game-related" aria-label="More games">
          <h2>More games</h2>
          <div className="electron-game-related-grid">
            {relatedGames.map((relatedGame) => (
              <GameTile
                className="electron-game-related-tile"
                game={relatedGame}
                key={relatedGame.id}
                onOpen={() => onOhMyGame(relatedGame.id)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function GameShareDialog({ game, onClose }: { game: CommunityGame; onClose: () => void }) {
  const titleId = useId();
  const linkId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const data = { title: game.title, text: game.description, url: game.playUrl };
  const canShare = !window.ohMyGameDesktop && typeof navigator.share === "function"
    && (!navigator.canShare || navigator.canShare(data));

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const dialog = dialogRef.current;
    dialog?.showModal();
    linkRef.current?.select();
    return () => {
      dialog?.close();
      previousFocus?.focus();
    };
  }, []);

  async function copyLink() {
    setBusy(true);
    setCopied(false);
    setError(undefined);
    try {
      await navigator.clipboard.writeText(game.playUrl);
      setCopied(true);
    } catch {
      setError("Could not copy automatically. Select the link and copy it.");
      linkRef.current?.focus();
      linkRef.current?.select();
    } finally {
      setBusy(false);
    }
  }

  async function shareGame() {
    setBusy(true);
    setError(undefined);
    try {
      await navigator.share(data);
      onClose();
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError("Sharing is unavailable. Copy the game link instead.");
      }
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <dialog ref={dialogRef} className="game-share-dialog" aria-labelledby={titleId} onKeyDown={handleKeyDown} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="game-share-content">
        <header>
          <div><h2 id={titleId}>Share game</h2><p>{game.title}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close share dialog"><X size={17} /></button>
        </header>
        <label htmlFor={linkId}>Game link</label>
        <div className="game-share-link">
          <input ref={linkRef} id={linkId} readOnly value={game.playUrl} onFocus={(event) => event.currentTarget.select()} />
          <button className="game-share-copy" type="button" onClick={() => void copyLink()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
        {error ? <p className="game-share-error" role="alert">{error}</p> : null}
        {canShare ? <button className="game-share-native" type="button" onClick={() => void shareGame()} disabled={busy}><Share2 size={15} />More sharing options</button> : null}
      </div>
    </dialog>
  );
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
