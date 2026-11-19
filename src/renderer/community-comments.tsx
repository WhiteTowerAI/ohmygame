import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import { COMMUNITY_COMMENT_MAX_LENGTH, type CommunityComment } from "../shared/publish-v1.js";
import { addCommunityComment, ApiError, deleteCommunityComment, getCommunityComments } from "./api.js";
import { useAuth } from "./auth.js";
import { language, t } from "./i18n.js";
import { LoaderCircle, Trash2 } from "./icons.js";
import { Button, IconButton, Textarea } from "./ui/index.js";
import { UserAvatar } from "./user-avatar.js";

/** The counter shows once a comment gets close to the limit. */
const SHOW_LENGTH_FROM = COMMUNITY_COMMENT_MAX_LENGTH - 100;

/** A listed game's comments, newest first. Anyone can read them; an account
 * writes them, and its own, or any on its own game, it can delete. */
export function GameComments({ game, onCountChange }: {
  game: CommunityGame;
  onCountChange: (count: number) => void;
}) {
  const auth = useAuth();
  const user = auth.state.status === "signed-in" ? auth.state.user : undefined;
  const ownsGame = user?.id === game.author.id;
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [cursor, setCursor] = useState<string>();
  // "hidden": the Cloud answered 404, because the game is no longer listed or the Cloud
  // predates comments (it answers 404 for routes it doesn't have). Either way there is nothing to show.
  const [status, setStatus] = useState<"loading" | "ready" | "failed" | "hidden">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState<string>();
  // Answers for a game the page has since left are dropped.
  const shownGame = useRef(game.id);
  shownGame.current = game.id;
  const count = useRef(game.stats?.commentCount);
  count.current = game.stats?.commentCount;

  async function load(gameId: string, after?: string) {
    try {
      const page = await getCommunityComments(gameId, after);
      if (shownGame.current !== gameId) return;
      // A comment written while paging can come again at the top of the next page.
      setComments(previous => {
        const shown = new Set(previous.map(comment => comment.id));
        return [...(after ? previous : []), ...page.comments.filter(comment => !after || !shown.has(comment.id))];
      });
      setCursor(page.nextCursor);
      setStatus("ready");
    } catch (cause) {
      if (shownGame.current !== gameId) return;
      if (after) setError(failure(cause));
      else setStatus(cause instanceof ApiError && cause.status === 404 ? "hidden" : "failed");
    }
  }

  useEffect(() => {
    setComments([]);
    setCursor(undefined);
    setStatus("loading");
    setDraft("");
    setError(undefined);
    void load(game.id);
  }, [game.id]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try { await load(game.id, cursor); }
    finally { setLoadingMore(false); }
  }

  async function post(event?: FormEvent) {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || posting) return;
    const gameId = game.id;
    setPosting(true);
    setError(undefined);
    try {
      const token = await auth.requestAccessToken();
      if (!token || shownGame.current !== gameId) return;
      const result = await addCommunityComment(gameId, token, body);
      if (shownGame.current !== gameId) return;
      setComments(previous => [result.comment, ...previous]);
      setDraft("");
      setStatus("ready");
      onCountChange(result.commentCount);
    } catch (cause) {
      if (shownGame.current === gameId) setError(failure(cause));
    } finally {
      setPosting(false);
    }
  }

  async function remove(comment: CommunityComment) {
    if (deleting) return;
    const gameId = game.id;
    setDeleting(comment.id);
    setError(undefined);
    try {
      const token = await auth.requestAccessToken();
      if (!token) return;
      await deleteCommunityComment(comment.id, token);
      if (shownGame.current !== gameId) return;
      setComments(previous => previous.filter(item => item.id !== comment.id));
      if (count.current !== undefined) onCountChange(Math.max(0, count.current - 1));
    } catch (cause) {
      // Already gone, by this account in another window or by the game's creator.
      if (cause instanceof ApiError && cause.status === 404) {
        if (shownGame.current === gameId) setComments(previous => previous.filter(item => item.id !== comment.id));
      } else if (shownGame.current === gameId) setError(failure(cause));
    } finally {
      setDeleting(undefined);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void post();
  }

  if (status === "hidden") return null;
  const length = [...draft.trim()].length;
  const total = game.stats?.commentCount;
  return (
    <section className="community-section community-comments" aria-labelledby="community-comments-title">
      <h2 id="community-comments-title">
        {t("community.comments")}
        {total ? <span className="community-comments-count">{t("community.commentCount", { count: total })}</span> : null}
      </h2>
      {user ? (
        <form className="community-comment-form" onSubmit={event => void post(event)}>
          <UserAvatar className="community-avatar community-comment-avatar" name={user.name} avatarUrl={user.avatarUrl} />
          <div className="community-comment-compose">
            <Textarea
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={keyDown}
              placeholder={t("community.commentPlaceholder")}
              aria-label={t("community.commentLabel")}
              maxLength={COMMUNITY_COMMENT_MAX_LENGTH * 2}
              rows={2}
              disabled={posting}
            />
            <div className="community-comment-compose-row">
              {length >= SHOW_LENGTH_FROM ? (
                <span className={`community-comment-length${length > COMMUNITY_COMMENT_MAX_LENGTH ? " is-over" : ""}`}>
                  {t("community.commentLength", { count: length, max: COMMUNITY_COMMENT_MAX_LENGTH })}
                </span>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={posting ? <LoaderCircle className="spin" size={14} /> : undefined}
                disabled={!length || length > COMMUNITY_COMMENT_MAX_LENGTH || posting}
              >
                {t("community.postComment")}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div>
          <Button size="sm" onClick={auth.openSignIn}>{t("community.commentSignIn")}</Button>
        </div>
      )}
      {error ? <p className="community-comments-error" role="alert">{error}</p> : null}
      {status === "loading" ? (
        <p className="community-comments-note" aria-busy="true"><LoaderCircle className="spin" size={14} /></p>
      ) : status === "failed" ? (
        <p className="community-comments-note">{t("community.commentsUnavailable")}</p>
      ) : status === "ready" && !comments.length ? (
        <p className="community-comments-note">{t("community.noComments")}</p>
      ) : null}
      {comments.length ? (
        <ol className="community-comment-list">
          {comments.map(comment => (
            <li key={comment.id} className="community-comment">
              <UserAvatar className="community-avatar community-comment-avatar" name={comment.author.displayName} avatarUrl={comment.author.avatarUrl} />
              <div className="community-comment-main">
                <div className="community-comment-head">
                  <strong>{comment.author.displayName}</strong>
                  <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString(language)}>{commentTime(comment.createdAt)}</time>
                  {user && (user.id === comment.author.id || ownsGame) ? (
                    <IconButton
                      className="community-comment-delete"
                      label={t("community.deleteComment")}
                      size="sm"
                      disabled={deleting === comment.id}
                      onClick={() => void remove(comment)}
                    >
                      {deleting === comment.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}
                    </IconButton>
                  ) : null}
                </div>
                {/* Comments are players' plain text; React shows it as text. */}
                <p className="community-comment-body">{comment.body}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
      {cursor ? (
        <div>
          <Button size="sm" variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}
            icon={loadingMore ? <LoaderCircle className="spin" size={14} /> : undefined}>
            {t("community.moreComments")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function failure(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 429) return t("community.commentRateLimited");
  if (cause instanceof ApiError && cause.status === 404) return t("community.commentsClosed");
  if (cause instanceof ApiError && cause.status === 503) return t("community.commentsUnavailable");
  return cause instanceof Error ? cause.message : String(cause);
}

/** "5 minutes ago" for the last week, then the date. */
export function commentTime(value: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(value) - now) / 1000);
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  for (const [unit, size] of [["second", 60], ["minute", 60], ["hour", 24], ["day", 7]] as const) {
    const step = unit === "second" ? 1 : unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400;
    if (Math.abs(seconds) < step * size) return relative.format(Math.round(seconds / step), unit);
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(new Date(value));
}
