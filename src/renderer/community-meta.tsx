import { useCallback, useEffect, useState } from "react";
import type { CommunityAuthor, CommunityStats, CommunitySubjectType } from "../shared/publish-v1.js";
import { getCommunityViewerState, recordCommunityUse, setCommunityLike } from "./api.js";
import { useAuth } from "./auth.js";
import { Heart } from "./icons.js";

export function useCommunityLike(type: CommunitySubjectType, id: string, stats: CommunityStats) {
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
    } catch {
      // The catalog remains usable if the optional social action fails.
    } finally {
      setBusy(false);
    }
  }, [auth, busy, id, liked, type]);

  return { busy, counts, liked, toggle };
}

export function CommunityLikeButton({ busy, count, liked, onToggle, showCount = true }: {
  busy: boolean;
  count: number;
  liked: boolean;
  onToggle: () => void;
  showCount?: boolean;
}) {
  return <button type="button" className={liked ? "is-liked" : ""} disabled={busy} onClick={onToggle} title={liked ? "Unlike" : "Like"} aria-label={liked ? "Unlike" : "Like"} aria-pressed={liked}>
    <Heart size={showCount ? 14 : 17} />{showCount ? count : null}
  </button>;
}

export function CommunityMetaSummary({ author, stats, useLabel }: {
  author: CommunityAuthor;
  stats: CommunityStats;
  useLabel: string;
}) {
  return <div className="community-meta">
    <CommunityAuthorView author={author} />
    <span className="community-stats">
      <span>{stats.likes} likes</span>
      <span>{stats.uses} {useLabel}</span>
    </span>
  </div>;
}

export function CommunityMeta({ type, id, author, stats, useLabel }: {
  type: CommunitySubjectType;
  id: string;
  author: CommunityAuthor;
  stats: CommunityStats;
  useLabel: string;
}) {
  const like = useCommunityLike(type, id, stats);

  return <div className="community-meta">
    <CommunityAuthorView author={author} />
    <span className="community-stats">
      <CommunityLikeButton busy={like.busy} count={like.counts.likes} liked={like.liked} onToggle={() => void like.toggle()} />
      <span>{like.counts.uses} {useLabel}</span>
    </span>
  </div>;
}

function CommunityAuthorView({ author }: { author: CommunityAuthor }) {
  return <span className="community-author">
    {author.avatarUrl ? <img src={author.avatarUrl} alt="" /> : <span aria-hidden="true">{author.displayName.slice(0, 1).toUpperCase()}</span>}
    <strong>{author.displayName}</strong>
  </span>;
}

export function useCommunityUseRecorder() {
  const auth = useAuth();
  return useCallback(async (type: CommunitySubjectType, id: string): Promise<void> => {
    if (auth.state.status !== "signed-in") return;
    const token = await auth.requestAccessToken();
    if (token) await recordCommunityUse(type, id, token);
  }, [auth.state.status]);
}
