/**
 * Cloud saves and leaderboards: what a game's page and the game service agree on.
 * docs/cloud-saves.md describes the routes; free of dependencies so the service can
 * import it.
 */

/** Where a game keeps cloud saves and leaderboards: manifest.json's "cloud". */
export interface CloudConfig {
  /** The game service's HTTPS base URL. */
  serverUrl: string;
  /** The game's ID on that service; for a game published to OhMyGame, its OhMyGame game ID. */
  gameId: string;
}

/** A save key or leaderboard name: letters, digits, dot, dash and underscore. */
export const CLOUD_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
/** The most save keys one player may keep in one game. */
export const SAVE_MAX_KEYS = 32;
/** The largest save, in bytes of its JSON. */
export const SAVE_MAX_BYTES = 64 * 1024;
/** Scores one player may submit to one game in a minute. */
export const SCORE_SUBMITS_PER_MINUTE = 10;
/** The most leaderboard entries one request returns. */
export const LEADERBOARD_PAGE_MAX = 100;

/** "desc": a higher score ranks first, as in points. "asc": lower ranks first, as in a time. */
export type LeaderboardOrder = "desc" | "asc";

export interface SaveRecord {
  key: string;
  value: unknown;
  /** Increases with every write; send it back as ifVersion to refuse a write over a newer one. */
  version: number;
  /** Milliseconds since the epoch, by the service's clock. */
  updatedAt: number;
}
/** A save without its value, as the key list returns it. */
export type SaveSummary = Omit<SaveRecord, "value"> & { bytes: number };

export interface LeaderboardEntry {
  rank: number;
  /** The player's OhMyGame account ID. Only signed-in players appear on a public board. */
  playerId: string;
  name: string;
  score: number;
  /** When the player set this score, in milliseconds since the epoch. */
  at: number;
}

/**
 * The player's own best on a board. A guest's score is kept for them only: public is
 * false and rank is where the score would place among signed-in players.
 */
export interface PlayerScore {
  score: number;
  at: number;
  rank: number;
  public: boolean;
}

/** The answer to a submitted score. */
export interface ScoreResult extends PlayerScore {
  /** Whether this score replaced the player's previous best. */
  improved: boolean;
}

/** Codes the service sends with an error, beside its message. */
export type CloudErrorCode = "quota_exceeded" | "rate_limited" | "conflict" | "not_found" | "invalid_request" | "not_authorized";

export function isCloudConfig(value: unknown, options: { allowLocalhost?: boolean } = {}): value is CloudConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { serverUrl, gameId, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof serverUrl !== "string" || typeof gameId !== "string") return false;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(gameId)) return false;
  try {
    const url = new URL(serverUrl);
    const local = options.allowLocalhost === true && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || local) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}
