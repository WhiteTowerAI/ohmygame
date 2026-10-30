import { language, t } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import type { CommunityGameStats } from "../shared/publish-v1.js";
import { ApiError, getExploreGameCover, setCommunityLike } from "./api.js";
import { useAuth } from "./auth.js";
import { Eye, Gamepad2, Heart, LoaderCircle } from "./icons.js";
import { communityProfileHash } from "./routes.js";
import { Button } from "./ui/index.js";
import { UserAvatar } from "./user-avatar.js";
import "./community.css";

export function GameGrid<T extends CommunityGame>({
  games,
  onOpen,
  accessToken,
  onStatsChange,
}: {
  games: T[];
  onOpen: (game: T) => void;
  accessToken?: string;
  onStatsChange?: (gameId: string, stats: CommunityGameStats) => void;
}) {
  return (
    <div className="community-grid">
      {games.map((game) => (
        <GameTile
          key={game.id}
          game={game}
          onOpen={() => onOpen(game)}
          accessToken={accessToken}
          onStatsChange={onStatsChange}
        />
      ))}
    </div>
  );
}

/** A cover card: the cover is the card and the text sits under it. The title
 * button covers the whole card; the creator and like stay clickable above it. */
export function GameTile({
  game,
  onOpen,
  accessToken,
  onStatsChange,
}: {
  game: CommunityGame;
  onOpen: () => void;
  accessToken?: string;
  onStatsChange?: (gameId: string, stats: CommunityGameStats) => void;
}) {
  const tile = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    if (tile.current) observer.observe(tile.current);
    return () => observer.disconnect();
  }, []);
  const coverUrl = useGameCover(visible ? game : undefined, accessToken);
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
          aria-label={t("community.play", { title: game.title })}
          title={game.description || game.title}
          onClick={onOpen}
        >
          {game.title}
        </button>
      </h2>
      <div className="community-card-meta">
        <CreatorLink author={game.author} />
        <GameStats
          game={game}
          onChange={
            onStatsChange ? (stats) => onStatsChange(game.id, stats) : undefined
          }
        />
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
      if (isCurrent())
        onChange({
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
    <LoaderCircle className="spin" size={14} />
  ) : (
    <Heart size={14} />
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
        <Eye size={14} />
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
          <Heart size={14} />
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

export function useGameCover(
  game: CommunityGame | undefined,
  accessToken?: string,
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
    if (!game?.coverUrl || direct) return;
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
  }, [game?.coverUrl, game?.deploymentId, game?.id, accessToken, direct]);
  return direct ?? url;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function compactCount(count: number): string {
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}
