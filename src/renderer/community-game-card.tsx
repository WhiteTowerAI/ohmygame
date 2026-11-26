import { useNearViewport } from "./asset-gallery.js";
import { useListPage } from "./use-list-page.js";
import { language, t } from "./i18n.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import type { CommunityGameStats } from "../shared/publish-v1.js";
import { ApiError, getExploreGameCover, setCommunityLike } from "./api.js";
import { useAuth } from "./auth.js";
import { Eye, Gamepad2, Heart, Spinner } from "./icons.js";
import { communityProfileHash } from "./routes.js";
import { Button, Skeleton } from "./ui/index.js";
import { UserAvatar } from "./user-avatar.js";
import "./community.css";

export function GameGrid<T extends CommunityGame>({
  games,
  onOpen,
  accessToken,
  onStatsChange,
  keepPageAs,
  owned,
}: {
  games: T[];
  onOpen: (game: T) => void;
  accessToken?: string;
  onStatsChange?: (gameId: string, stats: CommunityGameStats) => void;
  /** Keeps how many cards were shown, for a page that restores its scroll. */
  keepPageAs?: string;
  /** The creator's own games: each card dates the game and holds these actions. */
  owned?: (game: T) => ReactNode;
}) {
  const page = useListPage(games.length, keepPageAs);
  return (
    <><div className="community-grid">
      {games.slice(0, page.limit).map((game) => (
        <GameTile
          key={game.id}
          game={game}
          onOpen={() => onOpen(game)}
          accessToken={accessToken}
          onStatsChange={onStatsChange}
          actions={owned?.(game)}
        />
      ))}
    </div>{page.next}</>
  );
}

/** Cards' shapes while the first list loads, so the grid doesn't jump when it arrives. */
export function GameGridSkeleton({ label, count = 8 }: { label: string; count?: number }) {
  return (
    <div className="community-grid" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <div className="community-card community-card-skeleton" key={index}>
          <Skeleton height="auto" radius={10} />
          <Skeleton width="62%" height={14} />
          <Skeleton width="38%" />
        </div>
      ))}
    </div>
  );
}

/** A cover card: the cover is the card and the text sits under it. The title
 * button covers the whole card and opens the game's page, where the game
 * starts; the creator and the like stay clickable above it. A creator's own card says
 * when the game was published, and holds its actions, instead of their name. */
export function GameTile({
  game,
  onOpen,
  accessToken,
  onStatsChange,
  actions,
}: {
  game: CommunityGame;
  onOpen: () => void;
  accessToken?: string;
  onStatsChange?: (gameId: string, stats: CommunityGameStats) => void;
  actions?: ReactNode;
}) {
  const [tile, visible] = useNearViewport<HTMLElement>();
  const coverUrl = useGameCover(game, accessToken, visible);
  return (
    <article ref={tile} className="community-card">
      {coverUrl ? (
        <img
          className="community-card-cover"
          src={coverUrl}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="community-card-cover is-empty" aria-hidden="true">
          <Gamepad2 size={28} />
        </span>
      )}
      <h2 className="community-card-title">
        <button
          className="community-card-open"
          type="button"
          title={game.description || game.title}
          onClick={onOpen}
        >
          {game.title}
        </button>
      </h2>
      <div className="community-card-meta">
        {actions ? <span className="community-card-date">{publishedDay(game.publishedAt)}</span> : <CreatorLink author={game.author} />}
        <GameStats
          game={game}
          onChange={
            onStatsChange ? (stats) => onStatsChange(game.id, stats) : undefined
          }
        />
        {actions}
      </div>
    </article>
  );
}

export function CreatorLink({
  author,
  size = "sm",
}: {
  author: CommunityGame["author"];
  size?: "sm" | "md";
}) {
  return (
    <a
      className={`community-creator community-creator-${size}`}
      href={communityProfileHash(author.id)}
      aria-label={t("community.viewProfile", { name: author.displayName })}
    >
      <UserAvatar
        className="community-avatar"
        name={author.displayName}
        avatarUrl={author.avatarUrl}
      />
      <span>{author.displayName}</span>
    </a>
  );
}

/** Views and likes. Cards show both as small counts; the game page shows the
 * like as a button beside Share. */
export function GameStats({
  game,
  onChange,
  variant = "card",
}: {
  game: CommunityGame;
  onChange?: (stats: CommunityGameStats) => void;
  variant?: "card" | "page";
}) {
  const auth = useAuth();
  const userId =
    auth.state.status === "signed-in" ? auth.state.user.id : undefined;
  const currentIdentity = useRef({ gameId: game.id, userId });
  if (
    currentIdentity.current.gameId !== game.id ||
    currentIdentity.current.userId !== userId
  ) {
    currentIdentity.current = { gameId: game.id, userId };
  }
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stats = game.stats;
  const currentStats = useRef(stats);
  currentStats.current = stats;
  const statsIdentity = useRef({ stats, userId });
  if (statsIdentity.current.stats !== stats)
    statsIdentity.current = { stats, userId };
  const liked = Boolean(
    statsIdentity.current.userId === userId && stats?.liked,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
  }, [game.id, userId]);

  async function like() {
    if (busy || !stats || !onChange) return;
    setBusy(true);
    setError(undefined);
    const identity = currentIdentity.current;
    const isCurrent = () =>
      mounted.current && currentIdentity.current === identity;
    try {
      const token = userId ? await auth.requestAccessToken() : undefined;
      if ((userId && !token) || !isCurrent()) return;
      const next = await setCommunityLike(game.id, token, !liked);
      // Preserve the game's comment count when the like response omits it.
      if (isCurrent())
        onChange({
          ...currentStats.current,
          ...next,
          viewCount: Math.max(
            next.viewCount,
            currentStats.current?.viewCount ?? 0,
          ),
        });
    } catch (cause) {
      if (isCurrent())
        setError(
          cause instanceof ApiError && cause.status === 429
            ? t("community.likeRateLimited")
            : cause instanceof ApiError && cause.status === 503
              ? t("community.likeUnavailable")
              : cause instanceof Error
                ? cause.message
                : String(cause),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const viewCount = stats?.viewCount;
  const viewLabel =
    viewCount !== undefined
      ? t("community.views", { count: viewCount })
      : t("community.viewCountUnavailable");
  const likes = stats ? compactCount(stats.likeCount) : "—";
  const likeLabel = stats
    ? t("community.likes", { count: stats.likeCount })
    : t("community.likesUnavailable");
  const likeIcon = busy ? (
    <Spinner size="sm" />
  ) : (
    <Heart size="sm" />
  );
  const likeProps = {
    onClick: () => void like(),
    disabled: busy || !stats,
    "aria-pressed": liked,
    "aria-label": t(liked ? "community.unlikeGame" : "community.likeGame", {
      title: game.title,
    }),
    title: likeLabel,
  };
  const canLike = onChange && game.listingStatus !== "unlisted";
  return (
    <div className={`community-stats community-stats-${variant}`}>
      <span
        className="community-count"
        aria-label={viewLabel}
        title={viewLabel}
      >
        <Eye size="sm" />
        {variant === "page" && viewCount !== undefined
          ? viewLabel
          : viewCount !== undefined
            ? compactCount(viewCount)
            : "—"}
      </span>
      {canLike && variant === "page" ? (
        <Button
          className={liked ? "is-liked" : undefined}
          icon={likeIcon}
          {...likeProps}
        >
          {likes}
        </Button>
      ) : canLike ? (
        <button
          type="button"
          className={`community-count community-like${liked ? " is-liked" : ""}`}
          {...likeProps}
        >
          {likeIcon}
          {likes}
        </button>
      ) : (
        <span
          className="community-count"
          aria-label={likeLabel}
          title={likeLabel}
        >
          <Heart size="sm" />
          {likes}
        </span>
      )}
      {error ? (
        <span className="community-stats-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** `near` gates only daemon reads; a hosted cover is a plain image the browser
 * loads lazily and keeps cached, so a list shown again has its covers at once. */
export function useGameCover(
  game: CommunityGame | undefined,
  accessToken?: string,
  near = true,
): string | undefined {
  const [url, setUrl] = useState<string>();
  // Hosted covers live on the play domain's edge cache, like the games themselves;
  // only loopback covers from local debug publishing still go through the daemon.
  const direct =
    game?.coverUrl && isHttpsUrl(game.coverUrl) ? game.coverUrl : undefined;
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    if (!game?.coverUrl || direct || !near) return;
    void getExploreGameCover(game.id, game.deploymentId, accessToken)
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
  }, [game?.coverUrl, game?.deploymentId, game?.id, accessToken, direct, near]);
  return direct ?? url;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The day a game was published, as its page and its creator's own card show it. */
export function publishedDay(value: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(value));
}

export function compactCount(count: number): string {
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}
