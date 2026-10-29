import { t } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import type {
  CommunityProfile,
  CommunityGameStats,
} from "../shared/publish-v1.js";
import {
  getCommunityProfile,
  getMyCommunityGames,
  waitForRuntime,
} from "./api.js";
import { useAuth } from "./auth.js";
import {
  CommunityToolbar,
  DEFAULT_COMMUNITY_FILTERS,
  filterCommunityGames,
} from "./community-filters.js";
import { GameGrid } from "./community-game-card.js";
import { LoaderCircle, RefreshCw } from "./icons.js";
import type { AppNavigationTarget } from "./routes.js";
import { CommunityPage, CommunityState } from "./community-page.js";
import { Button, IconButton } from "./ui/index.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { UserAvatar } from "./user-avatar.js";

function applyProfileStats(
  profile: CommunityProfile,
  changes: Map<string, CommunityGameStats>,
): CommunityProfile {
  let totalLikes = profile.totalLikes;
  const games = profile.games.map((game) => {
    const stats = changes.get(game.id);
    if (!stats) return game;
    totalLikes += stats.likeCount - (game.stats?.likeCount ?? 0);
    return { ...game, stats };
  });
  return { ...profile, games, totalLikes };
}

export function CommunityProfilePage({
  authorId,
  onNavigate,
  onBack,
  onOpenGame,
}: {
  authorId: string;
  onNavigate: (page: AppNavigationTarget) => void;
  onBack: () => void;
  onOpenGame: (gameId: string) => void;
}) {
  const auth = useAuth();
  const generation = useReadyRuntimeGeneration();
  const owner =
    auth.state.status === "signed-in" && auth.state.user.id === authorId;
  const [profile, setProfile] = useState<CommunityProfile>();
  const [accessToken, setAccessToken] = useState<string>();
  const [filters, setFilters] = useState({ ...DEFAULT_COMMUNITY_FILTERS });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const pendingChanges = useRef<Map<string, CommunityGameStats> | undefined>(
    undefined,
  );

  async function load() {
    const current = ++version.current;
    const changes = new Map<string, CommunityGameStats>();
    pendingChanges.current = changes;
    setLoading(true);
    setError(undefined);
    try {
      await waitForRuntime();
      const token =
        auth.state.status === "signed-in"
          ? await auth.requestAccessToken()
          : undefined;
      if (owner && !token) throw new Error(t("community.manageSignIn"));
      const loaded = owner
        ? await getMyCommunityGames(token!)
        : await getCommunityProfile(authorId, token);
      if (current !== version.current) return;
      setProfile(applyProfileStats(loaded, changes));
      setAccessToken(owner ? token : undefined);
    } catch (cause) {
      if (current === version.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (pendingChanges.current === changes)
        pendingChanges.current = undefined;
      if (current === version.current) setLoading(false);
    }
  }

  function updateStats(gameId: string, stats: CommunityGameStats) {
    pendingChanges.current?.set(gameId, stats);
    setProfile((previous) =>
      previous?.author.id === authorId
        ? applyProfileStats(previous, new Map([[gameId, stats]]))
        : previous,
    );
  }

  useEffect(() => {
    setProfile(undefined);
    setAccessToken(undefined);
  }, [authorId, generation, owner]);

  useEffect(() => {
    setProfile((previous) =>
      previous
        ? {
            ...previous,
            games: previous.games.map((game) =>
              game.stats
                ? { ...game, stats: { ...game.stats, liked: undefined } }
                : game,
            ),
          }
        : previous,
    );
    void load();
    return () => {
      version.current += 1;
    };
  }, [
    authorId,
    generation,
    auth.state.status,
    auth.state.status === "signed-in" ? auth.state.user.id : undefined,
  ]);

  const visible = filterCommunityGames(profile?.games ?? [], filters);
  // The service has no total; sum the games' counts while every one has them.
  const totalViews = profile?.games.every((game) => game.stats)
    ? profile.games.reduce((sum, game) => sum + game.stats!.viewCount, 0)
    : undefined;
  return (
    <CommunityPage
      onNavigate={onNavigate}
      onBack={onBack}
      actions={
        <IconButton
          label={t("common.refresh")}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "spin" : undefined} />
        </IconButton>
      }
    >
      {profile ? (
        <header className="community-profile-summary">
          <UserAvatar
            className="community-avatar community-avatar-lg"
            name={profile.author.displayName}
            avatarUrl={profile.author.avatarUrl}
          />
          <div>
            <h1>
              {profile.author.displayName}
              {owner ? <small>{t("community.myProfile")}</small> : null}
            </h1>
            <p>
              {[
                t("community.publishedGames", { count: profile.games.length }),
                ...(totalViews !== undefined
                  ? [t("community.views", { count: totalViews })]
                  : []),
                t("community.likes", { count: profile.totalLikes }),
              ].join(" · ")}
            </p>
          </div>
        </header>
      ) : null}
      {error ? (
        <CommunityState
          tone="error"
          action={
            <Button size="sm" onClick={() => void load()}>
              {t("common.retry")}
            </Button>
          }
        >
          {error}
        </CommunityState>
      ) : null}
      {loading && !profile ? (
        <CommunityState>
          <LoaderCircle className="spin" size={16} />
          {t("community.loadingProfile")}
        </CommunityState>
      ) : null}
      {profile ? (
        <section className="community-section">
          <h2>{t("community.games")}</h2>
          <CommunityToolbar value={filters} onChange={setFilters} search />
          {!loading && !visible.length ? (
            <CommunityState>
              {profile.games.length
                ? t("community.noMatches")
                : t("community.none")}
            </CommunityState>
          ) : null}
          {visible.length ? (
            <GameGrid
              games={visible}
              accessToken={owner ? accessToken : undefined}
              onOpen={(game) => onOpenGame(game.id)}
              onStatsChange={owner ? undefined : updateStats}
            />
          ) : null}
        </section>
      ) : null}
    </CommunityPage>
  );
}
