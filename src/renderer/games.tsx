import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Check, Copy, Globe2, LoaderCircle, Maximize, Share2 } from "./icons.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import { gameShareUrl, readableUrl, type CommunityGameStats } from "../shared/publish-v1.js";
import { CreatorLink, GameGrid, GameGridSkeleton, GameStats } from "./community-game-card.js";
import { CommunityGameActions } from "./community-game-actions.js";
import { CommunitySearch, CommunityToolbar, filterCommunityGames, type CommunityFilters } from "./community-filters.js";
import { CommunityPage, CommunityState } from "./community-page.js";
import { GameLoader } from "./community-game-loader.js";
import {
  cachedGame,
  cachedGames,
  cachedListFilters,
  cachedRelatedGames,
  communityViewer,
  forgetCachedGame,
  keepGame,
  keepGames,
  keepListFilters,
  updateCachedGame,
} from "./community-cache.js";
import { useAuth } from "./auth.js";
import { ApiError, getExploreGame, listExploreGames, waitForRuntime } from "./api.js";
import { communityProfileHash, type AppNavigationTarget } from "./routes.js";
import { Button, Dialog, IconButton, Input, Skeleton } from "./ui/index.js";
import { language, t } from "./i18n.js";

const RELATED_GAMES_LIMIT = 10;
/** How old the list may get before the window coming back reloads it. */
export const COMMUNITY_REFRESH_AFTER_MS = 60_000;

function withoutLike(game: CommunityGame): CommunityGame {
  return game.stats ? { ...game, stats: { ...game.stats, liked: undefined } } : game;
}

/** A read that started before the player counted this visit must not lower its count. */
function keepLaterViews(next: CommunityGame, previous: CommunityGame | undefined): CommunityGame {
  return previous?.id === next.id && previous.stats && next.stats && previous.stats.viewCount > next.stats.viewCount
    ? { ...next, stats: { ...next.stats, viewCount: previous.stats.viewCount } }
    : next;
}

export function GamesPage({
  onNavigate,
  onOhMyGame,
}: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOhMyGame: (gameId: string) => void;
}) {
  const auth = useAuth();
  const serviceGeneration = useReadyRuntimeGeneration();
  const viewer = communityViewer(auth.state);
  const [filters, setFilters] = useState(cachedListFilters);
  const [openingProfile, setOpeningProfile] = useState(false);
  const loadVersion = useRef(0);
  const loadedAt = useRef<number | undefined>(undefined);
  const pendingStats = useRef<Map<string, CommunityGameStats> | undefined>(undefined);
  // A list seen earlier in this window shows at once and refreshes behind it.
  const [cached] = useState(() => cachedGames(viewer));
  const [games, setGames] = useState<CommunityGame[]>(cached ?? []);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(cached ? "ready" : "loading");
  const [error, setError] = useState<string>();
  const shownPhase = useRef(phase);
  shownPhase.current = phase;
  const shownViewer = useRef(viewer);

  // A background load keeps the grid in place, and keeps it when it fails.
  async function load(background = false) {
    const version = ++loadVersion.current;
    const changes = new Map<string, CommunityGameStats>();
    pendingStats.current = changes;
    if (!background) {
      setPhase("loading");
      setError(undefined);
    }
    try {
      await waitForRuntime();
      const token = auth.state.status === "signed-in" ? await auth.requestAccessToken() : undefined;
      const loaded = await listExploreGames(token);
      if (version !== loadVersion.current) return;
      // Keep likes made while the list request was in flight.
      const merged = loaded.map(game => changes.has(game.id) ? { ...game, stats: changes.get(game.id) } : game);
      keepGames(viewer, merged);
      setGames(merged);
      setPhase("ready");
      setError(undefined);
      loadedAt.current = Date.now();
    } catch (cause) {
      if (version !== loadVersion.current || background) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    } finally {
      if (pendingStats.current === changes) pendingStats.current = undefined;
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;

  // New games and counts arrive when the window comes back after a while.
  useEffect(() => {
    const refreshIfStale = () => {
      // pendingStats is set while a load is in flight; that load brings fresh games.
      if (document.visibilityState === "visible" && !pendingStats.current && loadedAt.current !== undefined && Date.now() - loadedAt.current >= COMMUNITY_REFRESH_AFTER_MS) {
        loadedAt.current = Date.now();
        void loadRef.current(true);
      }
    };
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", refreshIfStale);
    return () => {
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", refreshIfStale);
    };
  }, []);

  useEffect(() => {
    if (shownViewer.current !== viewer) {
      shownViewer.current = viewer;
      setGames(previous => previous.map(withoutLike));
    }
    // A shown list stays while it reloads, including after sign-in or a reconnect.
    void load(shownPhase.current === "ready");
    return () => { loadVersion.current += 1; };
  }, [serviceGeneration, viewer]);
  const visibleGames = filterCommunityGames(games, filters);
  useEffect(() => {
    if (openingProfile && auth.state.status === "signed-in") {
      setOpeningProfile(false);
      window.location.hash = communityProfileHash(auth.state.user.id);
    }
  }, [openingProfile, auth.state]);

  function changeFilters(next: CommunityFilters) {
    keepListFilters(next);
    setFilters(next);
  }

  return (
    <CommunityPage onNavigate={onNavigate} scrollKey="games" title={t("community.title")} actions={(
      <>
        <CommunitySearch value={filters} onChange={changeFilters} />
        <Button icon={<Globe2 size={14} />} disabled={openingProfile || auth.state.status === "loading"} onClick={() => {
          if (auth.state.status === "signed-in") window.location.hash = communityProfileHash(auth.state.user.id);
          else {
            setOpeningProfile(true);
            void auth.requestAccessToken().then(token => { if (!token) setOpeningProfile(false); });
          }
        }}>{t("community.myGames")}</Button>
      </>
    )}>
      <CommunityToolbar value={filters} onChange={changeFilters} />
      {phase === "loading" && !games.length ? <GameGridSkeleton label={t("community.loading")} /> : null}
      {phase === "error" ? <CommunityState tone="error" action={<Button size="sm" onClick={() => void load()}>{t("common.retry")}</Button>}>{error}</CommunityState> : null}
      {phase === "ready" && games.length === 0 ? <CommunityState>{t("community.none")}</CommunityState> : null}
      {phase === "ready" && games.length > 0 && visibleGames.length === 0 ? <CommunityState>{t("community.noMatches")}</CommunityState> : null}
      {phase !== "error" && visibleGames.length > 0 ? <GameGrid games={visibleGames} keepPageAs="community-games" onOpen={game => onOhMyGame(game.id)} onStatsChange={(gameId, stats) => {
        pendingStats.current?.set(gameId, stats);
        updateCachedGame(viewer, gameId, { stats });
        setGames(previous => previous.map(game => game.id === gameId ? { ...game, stats } : game));
      }} /> : null}
    </CommunityPage>
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
  const viewer = communityViewer(auth.state);
  // A game opened from a card shows its details and starts playing at once;
  // the page's own read only brings them up to date.
  const [game, setGame] = useState(() => cachedGame(viewer, gameId));
  const [accessToken, setAccessToken] = useState<string>();
  const [relatedGames, setRelatedGames] = useState(() => cachedRelatedGames(viewer, gameId, RELATED_GAMES_LIMIT));
  const [error, setError] = useState<string>();
  const loadVersion = useRef(0);
  const shown = useRef({ gameId, serviceGeneration, viewer });
  const tokenRead = useRef<Promise<string | undefined>>(undefined);
  const pendingChanges = useRef<Map<string, Partial<CommunityGame>> | undefined>(undefined);
  const pendingStats = useRef<{ gameId: string; stats?: CommunityGameStats } | undefined>(undefined);

  async function load() {
    const version = ++loadVersion.current;
    const changes = new Map<string, Partial<CommunityGame>>();
    pendingChanges.current = changes;
    setError(undefined);
    const signedIn = auth.state.status === "signed-in";
    // The player may finish loading first; its metrics read waits for this token.
    const tokenReady = (async () => {
      await waitForRuntime();
      return signedIn ? await auth.requestAccessToken() : undefined;
    })();
    tokenRead.current = tokenReady;
    try {
      const token = await tokenReady;
      const related = listExploreGames(token, { limit: RELATED_GAMES_LIMIT, excludeGameId: gameId }).catch(() => undefined);
      const currentGame = await getExploreGame(gameId, token);
      if (version !== loadVersion.current) return;
      const next = keepLaterViews({ ...currentGame, ...changes.get(gameId) }, cachedGame(viewer, gameId));
      keepGame(viewer, next);
      setAccessToken(token);
      setGame(previous => keepLaterViews(next, previous));
      const games = await related;
      if (version !== loadVersion.current || !games) return;
      const nextRelated = games.map(game => ({ ...game, ...changes.get(game.id) }));
      keepGame(viewer, ...nextRelated);
      setRelatedGames(nextRelated);
    } catch (cause) {
      if (version !== loadVersion.current) return;
      // A game that is gone must not keep playing from what this window saw before.
      if (cause instanceof ApiError && cause.status === 404) {
        forgetCachedGame(gameId);
        setGame(undefined);
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (pendingChanges.current === changes) pendingChanges.current = undefined;
    }
  }

  useEffect(() => {
    const previous = shown.current;
    shown.current = { gameId, serviceGeneration, viewer };
    if (previous.gameId !== gameId || previous.serviceGeneration !== serviceGeneration) {
      setGame(cachedGame(viewer, gameId));
      setAccessToken(undefined);
      setRelatedGames(cachedRelatedGames(viewer, gameId, RELATED_GAMES_LIMIT));
    } else if (previous.viewer !== viewer) {
      setGame(previous => previous && withoutLike(previous));
      setRelatedGames(previous => previous.map(withoutLike));
    }
    void load();
    return () => { loadVersion.current += 1; };
  }, [gameId, serviceGeneration, viewer]);

  async function refreshStats(deploymentId: string) {
    const version = loadVersion.current;
    const refresh: { gameId: string; stats?: CommunityGameStats } = { gameId };
    pendingStats.current = refresh;
    try {
      // The play server counts the entry; this read only refreshes its result.
      const current = await getExploreGame(gameId, await tokenRead.current);
      if (version !== loadVersion.current || pendingStats.current !== refresh || current.deploymentId !== deploymentId) return;
      const stats = current.stats;
      if (!stats) return;
      const merge = (previous?: CommunityGameStats) => ({ ...stats, ...refresh.stats, viewCount: Math.max(stats.viewCount, previous?.viewCount ?? 0) });
      updateCachedGame(viewer, gameId, { stats: merge(cachedGame(viewer, gameId)?.stats) });
      setGame(previous => previous?.id === gameId && previous.deploymentId === deploymentId
        ? { ...previous, stats: merge(previous.stats) } : previous);
    } catch { /* Metrics must not interrupt the player. */ }
    finally { if (pendingStats.current === refresh) pendingStats.current = undefined; }
  }

  function updateGame(id: string, change: Partial<CommunityGame>) {
    const pending = pendingChanges.current;
    pending?.set(id, { ...pending.get(id), ...change });
    if (change.stats && pendingStats.current?.gameId === id) pendingStats.current.stats = change.stats;
    updateCachedGame(viewer, id, change);
    setGame(previous => previous?.id === id ? { ...previous, ...change } : previous);
    setRelatedGames(previous => previous.map(item => item.id === id ? { ...item, ...change } : item));
  }

  const owner = auth.state.status === "signed-in" && auth.state.user.id === game?.author.id;
  return (
    <CommunityPage onNavigate={onNavigate} onBack={onBack} scrollKey={`game:${gameId}`}>
      {error ? <CommunityState tone="error" action={<Button size="sm" onClick={() => void load()}>{t("common.retry")}</Button>}>{error}</CommunityState> : null}
      {game || !error ? (
        <GameDetail
          game={game}
          relatedGames={relatedGames}
          onOhMyGame={onOhMyGame}
          onPlayerLoad={deploymentId => void refreshStats(deploymentId)}
          onStatsChange={(id, stats) => updateGame(id, { stats })}
          actions={game && owner ? (
            <CommunityGameActions key={`${game.id}:${serviceGeneration}`} game={game} accessToken={accessToken} onChange={change => updateGame(game.id, change)} onUnpublished={() => {
              loadVersion.current += 1;
              forgetCachedGame(game.id);
              setGame(undefined);
              window.location.hash = communityProfileHash(game.author.id);
            }} />
          ) : undefined}
        />
      ) : null}
    </CommunityPage>
  );
}

/** The player, then the title, creator and actions. Until the game is known the
 * player shows its loading screen and the details their shapes; the loading
 * screen stays until the game's page has loaded. */
function GameDetail({ game, relatedGames, actions, onOhMyGame, onPlayerLoad, onStatsChange }: {
  game?: CommunityGame;
  relatedGames: CommunityGame[];
  actions?: ReactNode;
  onOhMyGame: (gameId: string) => void;
  onPlayerLoad: (deploymentId: string) => void;
  onStatsChange: (gameId: string, stats: CommunityGameStats) => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  // A new deployment starts the game again; the owner's dialogs stay open.
  const frameKey = game ? `${game.id}:${game.deploymentId}` : undefined;
  const [loadedFrame, setLoadedFrame] = useState<string>();
  const playing = frameKey !== undefined && loadedFrame === frameKey;

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerRef.current?.requestFullscreen();
  }

  return (
    <div className="community-game">
      <div className="community-player" ref={playerRef} aria-busy={!playing}>
        {game ? (
          <iframe
            key={frameKey}
            src={game.playUrl}
            onLoad={() => {
              setLoadedFrame(frameKey);
              onPlayerLoad(game.deploymentId);
            }}
            title={game.title}
            // A published game may open the OhMyGame sign-in popup; the desktop app allows only that page.
            sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
            allow="autoplay; fullscreen"
          />
        ) : null}
        <GameLoader loading={!playing} />
      </div>
      {game ? (
        <div className="community-game-info">
          <div className="community-game-title">
            <h1>{game.title}</h1>
            <div className="community-game-byline">
              <CreatorLink author={game.author} size="md" />
              <span>{publishedDate(game.publishedAt)}</span>
            </div>
          </div>
          <span className="community-spacer" />
          <div className="community-game-actions">
            <GameStats variant="page" game={game} onChange={stats => onStatsChange(game.id, stats)} />
            <Button icon={<Share2 size={14} />} aria-haspopup="dialog" onClick={() => setSharing(true)}>{t("community.shareButton")}</Button>
            <IconButton label={t("common.fullscreen")} onClick={() => void toggleFullscreen()}><Maximize size={16} /></IconButton>
            {actions}
          </div>
        </div>
      ) : (
        <div className="community-game-info" aria-busy="true" aria-label={t("community.loadingGame")}>
          <div className="community-game-title">
            <Skeleton width={240} height={22} />
            <Skeleton width={150} height={14} />
          </div>
        </div>
      )}
      {game?.description ? <p className="community-game-description">{game.description}</p> : null}

      {game ? <GameShareDialog game={game} open={sharing} onClose={() => setSharing(false)} /> : null}

      {relatedGames.length ? (
        <section className="community-section" aria-label={t("community.moreGames")}>
          <h2>{t("community.moreGames")}</h2>
          <GameGrid
            games={relatedGames}
            onOpen={relatedGame => onOhMyGame(relatedGame.id)}
            onStatsChange={onStatsChange}
          />
        </section>
      ) : null}
    </div>
  );
}

function GameShareDialog({ game, open, onClose }: { game: CommunityGame; open: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shareRef = useRef<HTMLDivElement>(null);
  const url = gameShareUrl(game);
  const data = { title: game.title, text: game.description, url };
  const canShare = !window.ohMyGameDesktop && typeof navigator.share === "function"
    && (!navigator.canShare || navigator.canShare(data));

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setError(undefined);
  }, [open]);

  async function copyLink() {
    setBusy(true);
    setCopied(false);
    setError(undefined);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError(t("community.copyFailed"));
      const link = shareRef.current?.querySelector("input");
      link?.focus();
      link?.select();
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

  return (
    <Dialog open={open} onClose={onClose} title={t("community.share")} description={game.title} size="sm">
      <div className="community-share" ref={shareRef}>
        <Input
          readOnly
          value={readableUrl(url)}
          aria-label={t("community.link")}
          onFocus={(event) => event.currentTarget.select()}
          suffix={(
            <IconButton size="sm" label={copied ? t("common.copied") : t("community.copyLink")} onClick={() => void copyLink()} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={14} /> : copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          )}
        />
        {error ? <p className="community-share-error" role="alert">{error}</p> : null}
        {canShare ? <Button icon={<Share2 size={14} />} onClick={() => void shareGame()} disabled={busy}>{t("community.moreSharing")}</Button> : null}
      </div>
    </Dialog>
  );
}

function publishedDate(value: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(value));
}
