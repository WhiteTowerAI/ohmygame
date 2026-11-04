import { timingSafeEqual } from "node:crypto";
import express, { type Application, type Request, type Response } from "express";
import {
  CLOUD_NAME_PATTERN,
  LEADERBOARD_PAGE_MAX,
  MATCH_BOARD_PREFIX,
  SAVE_MAX_BYTES,
  SAVE_MAX_KEYS,
  SCORE_SUBMITS_PER_MINUTE,
  type CloudErrorCode,
  type LeaderboardOrder,
} from "@ohmygame/sdk/cloud-protocol";
import { isRecord } from "@ohmygame/sdk/protocol";
import type { MultiplayerAuth, MultiplayerIdentity } from "./auth.js";
import { ConflictError, QuotaError, type ServerStore } from "./game-data.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GameDataOptions {
  store: ServerStore;
  /**
   * Whether the service keeps data for this game. Defaults to every game, for local
   * development and a service that runs only its own games. OhMyGame's service allows
   * only games published to OhMyGame; see publishedGameCheck.
   */
  allowGame?(gameId: string): boolean | Promise<boolean>;
  /** Days a guest's data stays after their last visit. Defaults to 30. */
  guestRetentionDays?: number;
  /** Days an account's data stays after its last visit to the game. Defaults to 365. */
  accountRetentionDays?: number;
  /**
   * A secret for operator requests, such as removing an account's data when it is deleted.
   * Without it those routes are off.
   */
  adminToken?: string;
}

/** Counts per key in one-minute windows. The service's own limiter has this shape. */
export interface GameDataRateLimit {
  take(key: string, limit: number): boolean;
}

/**
 * Allows a game when OhMyGame lists it as published: GET {cloudApiUrl}/v1/community/games/{id}
 * answers 200. Answers are cached, and a listed game is not checked again for cacheMs.
 */
export function publishedGameCheck(cloudApiUrl: string, options: { cacheMs?: number; fetch?: typeof fetch } = {}) {
  const cacheMs = options.cacheMs ?? 5 * 60 * 1000;
  const request = options.fetch ?? fetch;
  const known = new Map<string, { allowed: boolean; until: number }>();
  return async (gameId: string): Promise<boolean> => {
    const now = Date.now();
    const cached = known.get(gameId);
    if (cached && cached.until > now) return cached.allowed;
    let allowed: boolean;
    try {
      const response = await request(new URL(`/v1/community/games/${encodeURIComponent(gameId)}`, cloudApiUrl), {
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200 && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      allowed = response.status === 200;
    } catch {
      // An unreachable registry keeps the last answer rather than locking players out.
      if (cached) return cached.allowed;
      throw new Error("The game registry could not be reached.");
    }
    if (known.size >= 10_000) known.clear();
    // An unknown game is asked again sooner, so a game published a moment ago works soon.
    known.set(gameId, { allowed, until: now + (allowed ? cacheMs : Math.min(cacheMs, 30_000)) });
    return allowed;
  };
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: CloudErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Cloud saves and leaderboards, under /v1/games/:gameId. docs/cloud-saves.md describes them. */
export function mountGameData(app: Application, options: GameDataOptions, auth: MultiplayerAuth, rate: GameDataRateLimit) {
  const { store } = options;
  const guestRetention = (options.guestRetentionDays ?? 30) * DAY_MS;
  const accountRetention = (options.accountRetentionDays ?? 365) * DAY_MS;
  const json = express.json({ limit: SAVE_MAX_BYTES + 1024 });

  /** The calling player and the game, checked; every data route starts here. */
  async function player(request: Request): Promise<{ gameId: string; identity: MultiplayerIdentity }> {
    const gameId = String(request.params.gameId);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(gameId)) throw new RouteError(404, "not_found", "Game not found.");
    let identity: MultiplayerIdentity;
    try {
      // An account token names one game; a guest token works in any game the service allows.
      identity = await auth.authenticate(bearer(request.headers.authorization), { authPolicy: "guest-or-account", gameId });
    } catch (cause) {
      throw new RouteError(401, "not_authorized", cause instanceof Error ? cause.message : "A valid player token is required.");
    }
    if (!rate.take(`data:${identity.userId}`, 120)) throw new RouteError(429, "rate_limited", "Too many requests. Try again in a minute.");
    if (!(await allowed(gameId))) throw new RouteError(404, "not_found", "This game does not keep cloud data on this service.");
    await store.touch(gameId, identity.userId, Date.now());
    return { gameId, identity };
  }
  async function allowed(gameId: string): Promise<boolean> {
    if (!options.allowGame) return true;
    try {
      return await options.allowGame(gameId);
    } catch {
      throw new RouteError(503, "not_found", "The service cannot check this game right now. Try again shortly.");
    }
  }
  const name = (value: unknown, what: string): string => {
    if (typeof value !== "string" || !CLOUD_NAME_PATTERN.test(value))
      throw new RouteError(400, "invalid_request", `A ${what} is 1 to 64 letters, digits, dots, dashes or underscores.`);
    return value;
  };
  const route = (run: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response) => {
    run(request, response).catch((cause: unknown) => {
      const error =
        cause instanceof RouteError ? cause
        : cause instanceof QuotaError ? new RouteError(413, "quota_exceeded", cause.message)
        : cause instanceof ConflictError ? new RouteError(409, "conflict", cause.message)
        : new RouteError(500, "invalid_request", "The request failed.");
      if (error.status === 500) console.error(cause);
      response.status(error.status).json({ error: error.message, code: error.code });
    });
  };

  app.get("/v1/games/:gameId/saves", route(async (request, response) => {
    const { gameId, identity } = await player(request);
    response.json(await store.listSaves(gameId, identity.userId));
  }));
  app.get("/v1/games/:gameId/saves/:key", route(async (request, response) => {
    const { gameId, identity } = await player(request);
    const save = await store.getSave(gameId, identity.userId, name(request.params.key, "save key"));
    if (!save) throw new RouteError(404, "not_found", "No such save.");
    response.json(save);
  }));
  app.put("/v1/games/:gameId/saves/:key", json, route(async (request, response) => {
    const { gameId, identity } = await player(request);
    const key = name(request.params.key, "save key");
    const body = request.body as unknown;
    if (!isRecord(body) || !("value" in body) || Object.keys(body).some((field) => field !== "value" && field !== "ifVersion"))
      throw new RouteError(400, "invalid_request", "Send { value } and optionally { ifVersion }.");
    const ifVersion = body.ifVersion;
    if (ifVersion !== undefined && (!Number.isSafeInteger(ifVersion) || (ifVersion as number) < 0))
      throw new RouteError(400, "invalid_request", "ifVersion is a save's version, or 0 for a save that must not exist yet.");
    const value = JSON.stringify(body.value);
    if (value === undefined) throw new RouteError(400, "invalid_request", "A save is JSON data.");
    if (Buffer.byteLength(value) > SAVE_MAX_BYTES)
      throw new RouteError(413, "quota_exceeded", `A save holds at most ${SAVE_MAX_BYTES / 1024} KB of JSON.`);
    response.json(await store.putSave(gameId, identity.userId, key, value, {
      maxKeys: SAVE_MAX_KEYS,
      now: Date.now(),
      ...(ifVersion === undefined ? {} : { ifVersion: ifVersion as number }),
    }));
  }));
  app.delete("/v1/games/:gameId/saves/:key", route(async (request, response) => {
    const { gameId, identity } = await player(request);
    await store.deleteSave(gameId, identity.userId, name(request.params.key, "save key"));
    response.status(204).end();
  }));

  app.post("/v1/games/:gameId/leaderboards/:board/scores", json, route(async (request, response) => {
    const { gameId, identity } = await player(request);
    const board = name(request.params.board, "leaderboard name");
    if (board.startsWith(MATCH_BOARD_PREFIX))
      throw new RouteError(403, "not_authorized", "The service records match results on this leaderboard; players cannot submit to it.");
    const body = request.body as unknown;
    if (!isRecord(body) || Object.keys(body).some((field) => field !== "score" && field !== "order"))
      throw new RouteError(400, "invalid_request", "Send { score } and optionally { order }.");
    const score = body.score;
    if (typeof score !== "number" || !Number.isFinite(score) || Math.abs(score) > Number.MAX_SAFE_INTEGER)
      throw new RouteError(400, "invalid_request", "A score is a finite number.");
    const order = body.order as LeaderboardOrder | undefined;
    if (order !== undefined && order !== "desc" && order !== "asc") throw new RouteError(400, "invalid_request", 'order is "desc" or "asc".');
    if (!rate.take(`score:${gameId}:${identity.userId}`, SCORE_SUBMITS_PER_MINUTE))
      throw new RouteError(429, "rate_limited", `A player submits at most ${SCORE_SUBMITS_PER_MINUTE} scores a minute.`);
    // Only signed-in players appear on a public board; a guest's score is theirs to see.
    const { improved } = await store.submitScore(gameId, board, {
      playerId: identity.userId,
      name: identity.name ?? "Player",
      value: score,
      public: identity.kind === "account",
      ...(order ? { order } : {}),
      now: Date.now(),
    });
    response.json({ ...(await store.playerScore(gameId, board, identity.userId))!, improved });
  }));
  app.get("/v1/games/:gameId/leaderboards/:board", route(async (request, response) => {
    const { gameId } = await player(request);
    const board = name(request.params.board, "leaderboard name");
    const limit = Number(request.query.limit ?? 10);
    const offset = Number(request.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > LEADERBOARD_PAGE_MAX || !Number.isInteger(offset) || offset < 0 || offset > 100_000)
      throw new RouteError(400, "invalid_request", `limit is 1 to ${LEADERBOARD_PAGE_MAX}, and offset a whole number.`);
    response.json(await store.topScores(gameId, board, limit, offset));
  }));
  app.get("/v1/games/:gameId/leaderboards/:board/me", route(async (request, response) => {
    const { gameId, identity } = await player(request);
    const score = await store.playerScore(gameId, name(request.params.board, "leaderboard name"), identity.userId);
    if (!score) throw new RouteError(404, "not_found", "No score on this leaderboard yet.");
    response.json(score);
  }));

  if (options.adminToken) {
    const secret = Buffer.from(options.adminToken);
    app.delete("/v1/admin/accounts/:accountId", route(async (request, response) => {
      const given = Buffer.from(bearer(request.headers.authorization) ?? "");
      if (given.length !== secret.length || !timingSafeEqual(given, secret))
        throw new RouteError(401, "not_authorized", "The operator token is required.");
      const accountId = String(request.params.accountId);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw new RouteError(400, "invalid_request", "Invalid account ID.");
      await store.deletePlayer(`account:${accountId}`);
      response.status(204).end();
    }));
  }

  const prune = () =>
    store.prune({ guest: Date.now() - guestRetention, account: Date.now() - accountRetention }).catch((cause: unknown) => console.error("Pruning game data failed", cause));
  return { prune };
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}
