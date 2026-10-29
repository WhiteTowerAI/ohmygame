import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Check, Copy, LoaderCircle, Maximize, RefreshCw, Share2 } from "./icons.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import type { CommunityGameStats } from "../shared/publish-v1.js";
import { CreatorLink, GameGrid, GameStats } from "./community-game-card.js";
import { CommunityGameActions } from "./community-game-actions.js";
import { CommunitySearch, CommunityToolbar, DEFAULT_COMMUNITY_FILTERS, filterCommunityGames } from "./community-filters.js";
import { CommunityPage, CommunityState } from "./community-page.js";
import { useAuth } from "./auth.js";
import { getExploreGame, listExploreGames, waitForRuntime } from "./api.js";
import { communityProfileHash, type AppNavigationTarget } from "./routes.js";
import { Button, Dialog, IconButton, Input } from "./ui/index.js";
import { language, t } from "./i18n.js";

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
    <CommunityPage onNavigate={onNavigate} title={t("community.title")} actions={(
      <>
        <CommunitySearch value={filters} onChange={setFilters} />
        <Button disabled={openingProfile || auth.state.status === "loading"} onClick={() => {
          if (auth.state.status === "signed-in") window.location.hash = communityProfileHash(auth.state.user.id);
          else {
            setOpeningProfile(true);
            void auth.requestAccessToken().then(token => { if (!token) setOpeningProfile(false); });
          }
        }}>{t("community.myProfile")}</Button>
        <IconButton label={t("common.refresh")} onClick={() => void load()} disabled={phase === "loading"}>
          <RefreshCw className={phase === "loading" ? "spin" : undefined} size={16} />
        </IconButton>
      </>
    )}>
      <CommunityToolbar value={filters} onChange={setFilters} />
      {phase === "loading" && !games.length ? <CommunityState><LoaderCircle className="spin" size={16} />{t("community.loading")}</CommunityState> : null}
      {phase === "error" ? <CommunityState tone="error" action={<Button size="sm" onClick={() => void load()}>{t("common.retry")}</Button>}>{error}</CommunityState> : null}
      {phase === "ready" && games.length === 0 ? <CommunityState>{t("community.none")}</CommunityState> : null}
      {phase === "ready" && games.length > 0 && visibleGames.length === 0 ? <CommunityState>{t("community.noMatches")}</CommunityState> : null}
      {phase !== "error" && visibleGames.length > 0 ? <GameGrid games={visibleGames} onOpen={game => onOhMyGame(game.id)} onStatsChange={(gameId, stats) => {
        pendingStats.current?.set(gameId, stats);
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
  const [game, setGame] = useState<CommunityGame>();
  const [accessToken, setAccessToken] = useState<string>();
  const [relatedGames, setRelatedGames] = useState<CommunityGame[]>([]);
  const [error, setError] = useState<string>();
  const loadVersion = useRef(0);
  const pendingChanges = useRef<Map<string, Partial<CommunityGame>> | undefined>(undefined);
  const pendingStats = useRef<{ gameId: string; stats?: CommunityGameStats } | undefined>(undefined);

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
      const games = await related;
      if (version === loadVersion.current) setRelatedGames(games.map(game => ({ ...game, ...changes.get(game.id) })));
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

  async function refreshStats(deploymentId: string) {
    const version = loadVersion.current;
    const refresh: { gameId: string; stats?: CommunityGameStats } = { gameId };
    pendingStats.current = refresh;
    try {
      // The play server counts the entry; this read only refreshes its result.
      const current = await getExploreGame(gameId, accessToken);
      if (version !== loadVersion.current || pendingStats.current !== refresh || current.deploymentId !== deploymentId) return;
      const stats = current.stats;
      if (stats) setGame(previous => previous?.id === gameId && previous.deploymentId === deploymentId
        ? { ...previous, stats: { ...stats, ...refresh.stats, viewCount: Math.max(stats.viewCount, previous.stats?.viewCount ?? 0) } } : previous);
    } catch { /* Metrics must not interrupt the player. */ }
    finally { if (pendingStats.current === refresh) pendingStats.current = undefined; }
  }

  function updateGame(id: string, change: Partial<CommunityGame>) {
    const pending = pendingChanges.current;
    pending?.set(id, { ...pending.get(id), ...change });
    if (change.stats && pendingStats.current?.gameId === id) pendingStats.current.stats = change.stats;
    setGame(previous => previous?.id === id ? { ...previous, ...change } : previous);
    setRelatedGames(previous => previous.map(item => item.id === id ? { ...item, ...change } : item));
  }

  const owner = auth.state.status === "signed-in" && auth.state.user.id === game?.author.id;
  return (
    <CommunityPage onNavigate={onNavigate} onBack={onBack}>
      {!game && !error ? <CommunityState><LoaderCircle className="spin" size={16} />{t("community.loadingGame")}</CommunityState> : null}
      {error ? <CommunityState tone="error" action={<Button size="sm" onClick={() => void load()}>{t("common.retry")}</Button>}>{error}</CommunityState> : null}
      {game ? (
        <GameDetail
          game={game}
          relatedGames={relatedGames}
          onOhMyGame={onOhMyGame}
          onPlayerLoad={() => void refreshStats(game.deploymentId)}
          onStatsChange={(id, stats) => updateGame(id, { stats })}
          actions={owner ? (
            <CommunityGameActions key={`${game.id}:${serviceGeneration}`} game={game} accessToken={accessToken} onChange={change => updateGame(game.id, change)} onUnpublished={() => {
              loadVersion.current += 1;
              setGame(undefined);
              window.location.hash = communityProfileHash(game.author.id);
            }} />
          ) : undefined}
        />
      ) : null}
    </CommunityPage>
  );
}

function GameDetail({ game, relatedGames, actions, onOhMyGame, onPlayerLoad, onStatsChange }: {
  game: CommunityGame;
  relatedGames: CommunityGame[];
  actions?: ReactNode;
  onOhMyGame: (gameId: string) => void;
  onPlayerLoad: () => void;
  onStatsChange: (gameId: string, stats: CommunityGameStats) => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerRef.current?.requestFullscreen();
  }

  return (
    <div className="community-game">
      <div className="community-player" ref={playerRef}>
        {/* A new deployment starts the game again; the owner's dialogs stay open. */}
        <iframe
          key={`${game.id}:${game.deploymentId}`}
          src={game.playUrl}
          onLoad={onPlayerLoad}
          title={game.title}
          sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
          allow="autoplay; fullscreen"
        />
      </div>
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
      {game.description ? <p className="community-game-description">{game.description}</p> : null}

      <GameShareDialog game={game} open={sharing} onClose={() => setSharing(false)} />

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
  const data = { title: game.title, text: game.description, url: game.playUrl };
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
      await navigator.clipboard.writeText(game.playUrl);
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
          value={game.playUrl}
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
