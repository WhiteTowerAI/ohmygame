import { useCallback, useEffect, useState } from "react";
import type { CommunityAuthor, CommunityStats, CommunitySubjectType } from "../shared/publish-v1.js";
import { getCommunityViewerState, recordCommunityUse, setCommunityLike } from "./api.js";
import { useAuth } from "./auth.js";
import { Heart, VerifiedCheck } from "./icons.js";

export function useCommunityLike(type: CommunitySubjectType, id: string, stats: CommunityStats, onStatsChange?: (stats: CommunityStats) => void) {
  const auth = useAuth();
  const [liked, setLiked] = useState(false);
  const [counts, setCounts] = useState(stats);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCounts(stats), [stats]);
  useEffect(() => {
    if (auth.state.status !== "signed-in") {
      setLiked(false);
      return;
    }
    setLiked(false);
    let active = true;
    void auth.requestAccessToken().then((token) => token ? getCommunityViewerState(type, id, token) : undefined)
      .then((viewer) => { if (active && viewer) setLiked(viewer.liked); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [auth.state.status, id, type]);

  const toggle = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const token = await auth.requestAccessToken();
      if (!token) return;
      const result = await setCommunityLike(type, id, !liked, token);
      setLiked(result.liked);
      setCounts(result.stats);
      onStatsChange?.(result.stats);
    } catch {
      // The catalog remains usable if the optional social action fails.
    } finally {
      setBusy(false);
    }
  }, [auth, busy, id, liked, onStatsChange, type]);

  return { busy, counts, liked, toggle };
}

export function CommunityLikeButton({ busy, count, liked, onToggle, showCount = true, showLabel = false }: {
  busy: boolean;
  count: number;
  liked: boolean;
  onToggle: () => void;
  showCount?: boolean;
  showLabel?: boolean;
}) {
  return <button type="button" className={["community-like-button", liked ? "is-liked" : "", showCount ? "has-count" : "", showLabel ? "has-label" : ""].filter(Boolean).join(" ")} disabled={busy} onClick={onToggle} title={liked ? "Unlike" : "Like"} aria-label={liked ? "Unlike" : "Like"} aria-pressed={liked}>
    <Heart size={showCount ? 14 : 17} />{showLabel ? <span>{liked ? "Liked" : "Like"}</span> : null}{showCount ? count : null}
  </button>;
}

export function CommunityMeta({ type, id, author, stats, useLabel, authorPrefix, verified = false, className, onStatsChange }: {
  type: CommunitySubjectType;
  id: string;
  author: CommunityAuthor;
  stats: CommunityStats;
  useLabel: string;
  authorPrefix?: string;
  verified?: boolean;
  className?: string;
  onStatsChange?: (stats: CommunityStats) => void;
}) {
  const like = useCommunityLike(type, id, stats, onStatsChange);

  return <div className={`community-meta${className ? ` ${className}` : ""}`}>
    <CommunityAuthorView author={author} prefix={authorPrefix} verified={verified} />
    <span className="community-stats">
      <CommunityLikeButton busy={like.busy} count={like.counts.likes} liked={like.liked} onToggle={() => void like.toggle()} />
      <span>{like.counts.uses} {useLabel}</span>
    </span>
  </div>;
}

export function CommunityAuthorView({ author, prefix, verified = false }: { author: CommunityAuthor; prefix?: string; verified?: boolean }) {
  return <span className="community-author">
    {author.avatarUrl ? <img src={author.avatarUrl} alt="" /> : <span aria-hidden="true">{author.displayName.slice(0, 1).toUpperCase()}</span>}
    <strong>{prefix ? `${prefix} ${author.displayName}` : author.displayName}</strong>
    {verified ? <VerifiedCheck className="community-author-verified" size={13} aria-label="Official" /> : null}
  </span>;
}

export function useCommunityUseRecorder() {
  const auth = useAuth();
  return useCallback(async (type: CommunitySubjectType, id: string): Promise<CommunityStats | undefined> => {
    if (auth.state.status !== "signed-in") return;
    const token = await auth.requestAccessToken();
    return token ? recordCommunityUse(type, id, token) : undefined;
  }, [auth.state.status]);
}
