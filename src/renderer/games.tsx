import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Check, Copy, LoaderCircle, Maximize, RefreshCw, Share2, UserRound, X } from "./icons.js";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import type { CommunityGameStats } from "../shared/publish-v1.js";
import { GameGrid, GameTile, GameStats, useGameCover } from "./community-game-card.js";
import { CommunityGameActions } from "./community-game-actions.js";
import { CommunityFilterButton, DEFAULT_COMMUNITY_FILTERS, filterCommunityGames } from "./community-filters.js";
import { useAuth } from "./auth.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";
import { getExploreGame, listExploreGames, recordCommunityView, waitForRuntime } from "./api.js";
import { communityProfileHash, type AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { language, t, tNodes } from "./i18n.js";

const RELATED_GAMES_LIMIT = 10;

export function GamesPage({
  onNavigate,
  onOhMyGame,
}: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOhMyGame: (gameId: string) => void;
}) {
  const auth = useAuth();
  const serviceGeneration = useReadyRuntimeGeneration();
  const [filters, setFilters] = useState({ ...DEFAULT_COMMUNITY_FILTERS });
  const [openingProfile, setOpeningProfile] = useState(false);
  const loadVersion = useRef(0);
  const pendingStats = useRef<Map<string, CommunityGameStats> | undefined>(undefined);
  const [games, setGames] = useState<CommunityGame[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();

  async function load() {
    const version = ++loadVersion.current;
    const changes = new Map<string, CommunityGameStats>();
    pendingStats.current = changes;
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const token = auth.state.status === "signed-in" ? await auth.requestAccessToken() : undefined;
      const loaded = await listExploreGames(token);
      if (version !== loadVersion.current) return;
      // Keep likes made while the list request was in flight.
      setGames(loaded.map(game => changes.has(game.id) ? { ...game, stats: changes.get(game.id) } : game));
      setPhase("ready");
    } catch (cause) {
      if (version !== loadVersion.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    } finally {
      if (pendingStats.current === changes) pendingStats.current = undefined;
    }
  }

  useEffect(() => {
    setGames(previous => previous.map(game => game.stats ? { ...game, stats: { ...game.stats, liked: undefined } } : game));
    void load();
    return () => { loadVersion.current += 1; };
  }, [serviceGeneration, auth.state.status, auth.state.status === "signed-in" ? auth.state.user.id : undefined]);
  const visibleGames = filterCommunityGames(games, filters);
  useEffect(() => {
    if (openingProfile && auth.state.status === "signed-in") {
      setOpeningProfile(false);
      window.location.hash = communityProfileHash(auth.state.user.id);
    }
  }, [openingProfile, auth.state]);

  return (
    <SidebarPageLayout active="community" onNavigate={onNavigate}>
      <SidebarPageHeader title={t("community.title")} actions={(
        <div className="community-header-actions">
        <CommunityFilterButton value={filters} onChange={setFilters} />
        <button className="projects-icon-button" type="button" title={t("community.myProfile")} aria-label={t("community.myProfile")} disabled={openingProfile || auth.state.status === "loading"} onClick={() => {
          if (auth.state.status === "signed-in") window.location.hash = communityProfileHash(auth.state.user.id);
          else {
            setOpeningProfile(true);
            void auth.requestAccessToken().then(token => { if (!token) setOpeningProfile(false); });
          }
        }}><UserRound size={15} /></button>
        <button className="projects-icon-button" type="button" onClick={() => void load()} disabled={phase === "loading"} title={t("common.refresh")} aria-label={t("common.refresh")}>
          <RefreshCw className={phase === "loading" ? "spin" : undefined} size={15} />
        </button>
        </div>
      )} />

      <section className="explore-content">
        {phase === "loading" && !games.length ? <div className="explore-state"><LoaderCircle className="spin" size={20} />{t("community.loading")}</div> : null}
        {phase === "error" ? <div className="explore-state explore-error"><X size={20} />{error}</div> : null}
        {phase === "ready" && games.length === 0 ? <div className="explore-state">{t("community.none")}</div> : null}
        {phase === "ready" && games.length > 0 && visibleGames.length === 0 ? <div className="explore-state">{t("community.noMatches")}</div> : null}
        {phase !== "error" && visibleGames.length > 0 ? <GameGrid games={visibleGames} onOpen={game => onOhMyGame(game.id)} onStatsChange={(gameId, stats) => {
          pendingStats.current?.set(gameId, stats);
          setGames(previous => previous.map(game => game.id === gameId ? { ...game, stats } : game));
        }} /> : null}
      </section>
    </SidebarPageLayout>
  );
}

export function GamePlayer({ gameId, onBack, onNavigate, onOhMyGame }: {
  gameId: string;
  onBack: () => void;
  onNavigate: (page: AppNavigationTarget) => void;
  onOhMyGame: (gameId: string) => void;
}) {
  const auth = useAuth();
  const serviceGeneration = useReadyRuntimeGeneration();
  const [game, setGame] = useState<CommunityGame>();
  const [accessToken, setAccessToken] = useState<string>();
  const [relatedGames, setRelatedGames] = useState<CommunityGame[]>([]);
  const [error, setError] = useState<string>();
  const loadVersion = useRef(0);
  const pendingChanges = useRef<Map<string, Partial<CommunityGame>> | undefined>(undefined);

  async function load() {
    const version = ++loadVersion.current;
    const changes = new Map<string, Partial<CommunityGame>>();
    pendingChanges.current = changes;
    setError(undefined);
    try {
      await waitForRuntime();
      const token = auth.state.status === "signed-in" ? await auth.requestAccessToken() : undefined;
      const related = listExploreGames(token, { limit: RELATED_GAMES_LIMIT, excludeGameId: gameId }).catch(() => []);
      const currentGame = await getExploreGame(gameId, token);
      if (version !== loadVersion.current) return;
      setAccessToken(token);
      setGame({ ...currentGame, ...changes.get(gameId) });
      await Promise.all([
        related.then(games => {
          if (version === loadVersion.current) setRelatedGames(games.map(game => ({ ...game, ...changes.get(game.id) })));
        }),
        (currentGame.listingStatus === "unlisted" ? Promise.resolve(undefined) : recordCommunityView(gameId, communityVisitorId(), token).catch(() => undefined)).then(stats => {
          if (stats && version === loadVersion.current) setGame(previous => previous?.id === gameId ? { ...previous, stats: { ...stats, ...changes.get(gameId)?.stats, viewerCount: stats.viewerCount } } : previous);
        }),
      ]);
    } catch (cause) {
      if (version !== loadVersion.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (pendingChanges.current === changes) pendingChanges.current = undefined;
    }
  }

  useEffect(() => {
    setGame(undefined);
    setAccessToken(undefined);
    setRelatedGames([]);
  }, [gameId, serviceGeneration]);

  useEffect(() => {
    setGame(previous => previous?.stats ? { ...previous, stats: { ...previous.stats, liked: undefined } } : previous);
    setRelatedGames(previous => previous.map(game => game.stats ? { ...game, stats: { ...game.stats, liked: undefined } } : game));
    void load();
    return () => { loadVersion.current += 1; };
  }, [gameId, serviceGeneration, auth.state.status, auth.state.status === "signed-in" ? auth.state.user.id : undefined]);

  function updateGame(id: string, change: Partial<CommunityGame>) {
    const pending = pendingChanges.current;
    pending?.set(id, { ...pending.get(id), ...change });
    setGame(previous => previous?.id === id ? { ...previous, ...change } : previous);
    setRelatedGames(previous => previous.map(item => item.id === id ? { ...item, ...change } : item));
  }

  const owner = auth.state.status === "signed-in" && auth.state.user.id === game?.author.id;
  return (
    <SidebarPageLayout active="community" onNavigate={onNavigate}>
      <SidebarPageHeader title={game?.title ?? t("community.game")} breadcrumb={{ label: t("community.games"), onClick: onBack }} actions={owner && game ? (
        <CommunityGameActions key={`${game.id}:${serviceGeneration}`} game={game} accessToken={accessToken} onChange={change => updateGame(game.id, change)} onUnpublished={() => {
          loadVersion.current += 1;
          setGame(undefined);
          window.location.hash = communityProfileHash(game.author.id);
        }} />
      ) : undefined} />
      <section className="game-detail-scroll">
        {!game && !error ? <div className="explore-state"><LoaderCircle className="spin" size={20} />{t("community.loadingGame")}</div> : null}
        {error ? (
          <div className="explore-state explore-error">
            <X size={20} />
            <span>{error}</span>
            <button className="quiet-button" type="button" onClick={() => void load()}>{t("common.retry")}</button>
          </div>
        ) : null}
        {game ? <GameDetail key={`${game.id}:${game.deploymentId}`} game={game} accessToken={owner ? accessToken : undefined} relatedGames={relatedGames} onOhMyGame={onOhMyGame} onStatsChange={(id, stats) => updateGame(id, { stats })} /> : null}
      </section>
    </SidebarPageLayout>
  );
}

function GameDetail({ game, accessToken, relatedGames, onOhMyGame, onStatsChange }: {
  game: CommunityGame;
  accessToken?: string;
  relatedGames: CommunityGame[];
  onOhMyGame: (gameId: string) => void;
  onStatsChange: (gameId: string, stats: CommunityGameStats) => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const coverUrl = useGameCover(game, accessToken);
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
              <span>{tNodes("community.byAuthor", { author: <a href={communityProfileHash(game.author.id)}>{game.author.displayName}</a> })} · {publishedDate(game.publishedAt)}</span>
              {game.description ? <p>{game.description}</p> : null}
            </div>
          </div>
          <div className="electron-game-toolbar-actions">
            <GameStats game={game} onChange={stats => onStatsChange(game.id, stats)} />
            <button type="button" onClick={() => setSharing(true)} title={t("community.share")} aria-label={t("community.share")} aria-haspopup="dialog"><Share2 size={17} /></button>
            <button type="button" onClick={() => void toggleFullscreen()} title={t("common.fullscreen")} aria-label={t("common.fullscreen")}><Maximize size={17} /></button>
          </div>
        </div>
      </div>

      {sharing ? <GameShareDialog game={game} onClose={() => setSharing(false)} /> : null}

      {relatedGames.length ? (
        <section className="electron-game-related" aria-label={t("community.moreGames")}>
          <h2>{t("community.moreGames")}</h2>
          <div className="electron-game-related-grid">
            {relatedGames.map((relatedGame) => (
              <GameTile
                className="electron-game-related-tile"
                game={relatedGame}
                key={relatedGame.id}
                onOpen={() => onOhMyGame(relatedGame.id)}
                onStatsChange={onStatsChange}
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
      setError(t("community.copyFailed"));
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
        setError(t("community.shareUnavailable"));
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
          <div><h2 id={titleId}>{t("community.share")}</h2><p>{game.title}</p></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("community.closeShare")}><X size={17} /></button>
        </header>
        <label htmlFor={linkId}>{t("community.link")}</label>
        <div className="game-share-link">
          <input ref={linkRef} id={linkId} readOnly value={game.playUrl} onFocus={(event) => event.currentTarget.select()} />
          <button className="game-share-copy" type="button" onClick={() => void copyLink()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? t("common.copied") : t("community.copyLink")}
          </button>
        </div>
        {error ? <p className="game-share-error" role="alert">{error}</p> : null}
        {canShare ? <button className="game-share-native" type="button" onClick={() => void shareGame()} disabled={busy}><Share2 size={15} />{t("community.moreSharing")}</button> : null}
      </div>
    </dialog>
  );
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(value));
}

let fallbackVisitorId: string | undefined;
function communityVisitorId(): string {
  try {
    const saved = localStorage.getItem("ohmygame-community-visitor");
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved)) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem("ohmygame-community-visitor", id);
    return id;
  } catch { return fallbackVisitorId ??= crypto.randomUUID(); }
}
