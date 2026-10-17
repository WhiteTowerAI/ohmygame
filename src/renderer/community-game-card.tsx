import { language, t } from "./i18n.js";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import type { CommunityGameStats } from "../shared/publish-v1.js";
import {
  HOME_GAME_MOSAIC_SLOTS,
  type GameMosaicSlot,
} from "../shared/game-mosaic.js";
import brandMark from "../shared/assets/ohmygame-mark-v2.svg";
import { getExploreGameCover, setCommunityLike } from "./api.js";
import { useAuth } from "./auth.js";
import { Eye, Heart, LoaderCircle } from "./icons.js";
import { communityProfileHash } from "./routes.js";

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
    <div className="explore-game-mosaics">
      {Array.from(
        { length: Math.ceil(games.length / HOME_GAME_MOSAIC_SLOTS.length) },
        (_, group) => {
          const start = group * HOME_GAME_MOSAIC_SLOTS.length;
          const batch = games.slice(
            start,
            start + HOME_GAME_MOSAIC_SLOTS.length,
          );
          return (
            <div
              key={group}
              className={`explore-game-mosaic${batch.length === HOME_GAME_MOSAIC_SLOTS.length ? " is-complete" : ""}`}
            >
              {batch.map((game, index) => (
                <GameTile
                  key={game.id}
                  game={game}
                  slot={HOME_GAME_MOSAIC_SLOTS[index]}
                  onOpen={() => onOpen(game)}
                  accessToken={accessToken}
                  onStatsChange={onStatsChange}
                />
              ))}
            </div>
          );
        },
      )}
    </div>
  );
}

export function GameTile({
  className = "",
  game,
  slot,
  onOpen,
  accessToken,
  onStatsChange,
}: {
  className?: string;
  game: CommunityGame;
  slot?: GameMosaicSlot;
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
  const style: (CSSProperties & Record<string, number>) | undefined = slot
    ? {
        "--mosaic-column": slot.column,
        "--mosaic-row": slot.row,
        "--mosaic-size": slot.size,
      }
    : undefined;
  return (
    <article
      ref={tile}
      className={`explore-game-tile explore-game-tile-size-${slot?.size ?? 1}${className ? ` ${className}` : ""}`}
      style={style}
    >
      {coverUrl ? (
        <img
          className="explore-game-cover"
          src={coverUrl}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="explore-game-cover-placeholder" aria-hidden="true">
          <img src={brandMark} alt="" />
        </span>
      )}
      <button
        className="explore-game-open"
        type="button"
        aria-label={t("community.play", { title: game.title })}
        onClick={onOpen}
      />
      <div className="explore-game-overlay">
        <div className="explore-game-overlay-copy">
          <strong className="community-card-title">{game.title}</strong>
          <a
            className="explore-game-creator"
            href={communityProfileHash(game.author.id)}
            aria-label={t("community.viewProfile", {
              name: game.author.displayName,
            })}
          >
            <span className="explore-game-creator-avatar" aria-hidden="true">
              <i>{game.author.displayName.slice(0, 1).toUpperCase()}</i>
              {game.author.avatarUrl ? (
                <img
                  src={game.author.avatarUrl}
                  alt=""
                  onError={(event) => {
                    event.currentTarget.hidden = true;
                  }}
                />
              ) : null}
            </span>
            <small>{game.author.displayName}</small>
          </a>
          <GameStats
            game={game}
            onChange={
              onStatsChange
                ? (stats) => onStatsChange(game.id, stats)
                : undefined
            }
          />
        </div>
      </div>
    </article>
  );
}

export function GameStats({
  game,
  onChange,
}: {
  game: CommunityGame;
  onChange?: (stats: CommunityGameStats) => void;
}) {
  const auth = useAuth();
  const userId =
    auth.state.status === "signed-in" ? auth.state.user.id : undefined;
  const currentIdentity = useRef({ gameId: game.id, userId });
  if (
    currentIdentity.current.gameId !== game.id ||
    (currentIdentity.current.userId &&
      currentIdentity.current.userId !== userId)
  ) {
    currentIdentity.current = { gameId: game.id, userId };
  } else {
    // A click that opens sign-in continues under the newly signed-in account.
    currentIdentity.current.userId = userId;
  }
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stats = game.stats;
  const liked = Boolean(userId && stats?.liked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setError(undefined);
  }, [game.id, userId]);

  async function like() {
    if (busy || !stats || !onChange) return;
    setBusy(true);
    setError(undefined);
    let identity = currentIdentity.current;
    const isCurrent = () =>
      mounted.current && currentIdentity.current === identity;
    try {
      const token = await auth.requestAccessToken();
      if (!token || !mounted.current) return;
      identity = currentIdentity.current;
      if (identity.gameId !== game.id || (userId && identity.userId !== userId))
        return;
      const next = await setCommunityLike(game.id, token, !liked);
      if (isCurrent()) onChange(next);
    } catch (cause) {
      if (isCurrent())
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const viewers = stats ? compactCount(stats.viewerCount) : "—";
  const likes = stats ? compactCount(stats.likeCount) : "—";
  const iconSize = "var(--community-stats-icon-size, 13px)";
  return (
    <div className="community-game-stats">
      <span
        aria-label={
          stats
            ? t("community.uniqueViewers", { count: stats.viewerCount })
            : t("community.viewCountUnavailable")
        }
        title={
          stats
            ? t("community.uniqueViewers", { count: stats.viewerCount })
            : t("community.viewCountUnavailable")
        }
      >
        <Eye size={iconSize} />
        {viewers}
      </span>
      {onChange && game.listingStatus !== "unlisted" ? (
        <button
          type="button"
          className={liked ? "is-liked" : undefined}
          onClick={() => void like()}
          disabled={busy || !stats}
          aria-pressed={liked}
          aria-label={t(liked ? "community.unlikeGame" : "community.likeGame", {
            title: game.title,
          })}
          title={
            stats
              ? t("community.likes", { count: stats.likeCount })
              : t("community.likesUnavailable")
          }
        >
          {busy ? (
            <LoaderCircle className="spin" size={iconSize} />
          ) : (
            <Heart size={iconSize} />
          )}
          {likes}
        </button>
      ) : (
        <span
          aria-label={
            stats
              ? t("community.likes", { count: stats.likeCount })
              : t("community.likesUnavailable")
          }
        >
          <Heart size={iconSize} />
          {likes}
        </span>
      )}
      {error ? (
        <span className="community-interaction-error" role="alert">
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
  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setUrl(undefined);
    if (!game?.coverUrl) return;
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
  }, [game?.coverUrl, game?.deploymentId, game?.id, accessToken]);
  return url;
}

function compactCount(count: number): string {
  return new Intl.NumberFormat(language, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count);
}
