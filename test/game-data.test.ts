import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gameTokenAudience } from "@ohmygame/sdk/account-protocol";
import { SAVE_MAX_BYTES, SAVE_MAX_KEYS, SCORE_SUBMITS_PER_MINUTE } from "@ohmygame/sdk/cloud-protocol";
import { ConflictError, createMultiplayerServer, MemoryGameDataStore, publishedGameCheck, QuotaError, type ServerStore } from "@ohmygame/server";
import { PostgresGameDataStore } from "@ohmygame/server/postgres";
import { GUEST_RENEWAL_MS, GUEST_TOKEN_MS, MultiplayerAuth } from "../packages/server/src/auth.js";

/** Set to a disposable database, such as postgres://localhost:5432/ohmygame_test, to run the Postgres store too. */
const POSTGRES_URL = process.env.OHMYGAME_TEST_POSTGRES_URL;

const stores: [string, () => Promise<ServerStore>][] = [["memory", async () => new MemoryGameDataStore()]];
if (POSTGRES_URL)
  stores.push([
    "postgres",
    async () => {
      const store = new PostgresGameDataStore({ connection: POSTGRES_URL });
      await store.migrate();
      // Each test starts from empty tables.
      const pool = (store as unknown as { pool: { query(text: string): Promise<unknown> } }).pool;
      await pool.query("TRUNCATE ohmygame_saves, ohmygame_scores, ohmygame_boards, ohmygame_players");
      return store;
    },
  ]);

describe.each(stores)("%s game data store", (_name, open) => {
  let store: ServerStore;
  beforeAll(async () => {
    store = await open();
  });
  afterAll(async () => {
    await store.close();
  });

  it("keeps saves per game and player, with versions, a key quota and conditional writes", async () => {
    const first = await store.putSave("g1", "account:a", "progress", JSON.stringify({ level: 2 }), { maxKeys: 2, now: 1000 });
    expect(first).toEqual({ key: "progress", value: { level: 2 }, version: 1, updatedAt: 1000 });
    const second = await store.putSave("g1", "account:a", "progress", JSON.stringify({ level: 3 }), { maxKeys: 2, ifVersion: 1, now: 2000 });
    expect(second.version).toBe(2);
    await expect(store.putSave("g1", "account:a", "progress", "{}", { maxKeys: 2, ifVersion: 1, now: 3000 })).rejects.toBeInstanceOf(ConflictError);
    await expect(store.putSave("g1", "account:a", "fresh", "1", { maxKeys: 2, ifVersion: 0, now: 3000 })).resolves.toMatchObject({ version: 1 });
    await expect(store.putSave("g1", "account:a", "third", "1", { maxKeys: 2, now: 3000 })).rejects.toBeInstanceOf(QuotaError);
    // Rewriting a kept key never counts against the quota.
    await expect(store.putSave("g1", "account:a", "fresh", "2", { maxKeys: 2, now: 3000 })).resolves.toMatchObject({ version: 2 });
    expect(await store.getSave("g1", "account:a", "progress")).toMatchObject({ value: { level: 3 }, version: 2 });
    expect(await store.getSave("g2", "account:a", "progress")).toBeUndefined();
    expect(await store.getSave("g1", "account:b", "progress")).toBeUndefined();
    expect(await store.listSaves("g1", "account:a")).toEqual([
      { key: "fresh", version: 2, updatedAt: 3000, bytes: 1 },
      { key: "progress", version: 2, updatedAt: 2000, bytes: 11 },
    ]);
    expect(await store.deleteSave("g1", "account:a", "fresh")).toBe(true);
    expect(await store.deleteSave("g1", "account:a", "fresh")).toBe(false);
  });

  it("keeps each player's best score, ranks public scores and places a guest privately", async () => {
    const submit = (playerId: string, value: number, now: number, order: "desc" | "asc" = "desc") =>
      store.submitScore("g1", "points", { playerId, name: playerId.slice(-1).toUpperCase(), value, public: playerId.startsWith("account:"), order, now });
    expect(await submit("account:a", 50, 1)).toEqual({ improved: true });
    expect(await submit("account:b", 80, 2)).toEqual({ improved: true });
    expect(await submit("account:c", 50, 3)).toEqual({ improved: true });
    expect(await submit("account:a", 40, 4)).toEqual({ improved: false });
    expect(await submit("guest:g", 70, 5)).toEqual({ improved: true });
    await expect(submit("account:a", 1, 6, "asc")).rejects.toThrow("This leaderboard ranks higher scores first.");
    // A score that names no order takes the board's.
    expect(await store.submitScore("g1", "points", { playerId: "account:a", name: "A", value: 45, public: true, now: 6 })).toEqual({ improved: false });
    // Ties go to the earlier score; the guest is not on the board.
    expect(await store.topScores("g1", "points", 10, 0)).toEqual([
      { rank: 1, playerId: "b", name: "B", score: 80, at: 2 },
      { rank: 2, playerId: "a", name: "A", score: 50, at: 1 },
      { rank: 3, playerId: "c", name: "C", score: 50, at: 3 },
    ]);
    expect(await store.topScores("g1", "points", 1, 1)).toEqual([{ rank: 2, playerId: "a", name: "A", score: 50, at: 1 }]);
    expect(await store.playerScore("g1", "points", "account:c")).toEqual({ score: 50, at: 3, rank: 3, public: true });
    expect(await store.playerScore("g1", "points", "guest:g")).toEqual({ score: 70, at: 5, rank: 2, public: false });
    expect(await store.playerScore("g1", "points", "account:z")).toBeUndefined();
    expect(await store.topScores("g1", "missing", 10, 0)).toEqual([]);

    await store.submitScore("g1", "time", { playerId: "account:a", name: "A", value: 30.5, public: true, order: "asc", now: 7 });
    expect((await store.submitScore("g1", "time", { playerId: "account:a", name: "A", value: 29.25, public: true, now: 8 })).improved).toBe(true);
    expect(await store.playerScore("g1", "time", "account:a")).toMatchObject({ score: 29.25, at: 8, rank: 1 });
  });

  it("counts up a board of match results", async () => {
    const add = (playerId: string, now: number) => store.addScore("g6", "match.wins", { playerId, name: playerId, delta: 1, public: true, now });
    await add("account:a", 1);
    await add("account:b", 2);
    await add("account:a", 3);
    expect((await store.topScores("g6", "match.wins", 10, 0)).map(({ playerId, score }) => [playerId, score])).toEqual([["a", 2], ["b", 1]]);
    await store.submitScore("g6", "time", { playerId: "account:a", name: "A", value: 1, public: true, order: "asc", now: 1 });
    await expect(store.addScore("g6", "time", { playerId: "account:a", name: "A", delta: 1, public: true, now: 2 })).rejects.toBeInstanceOf(ConflictError);
  });

  it("gives a guest's saves and scores in one game to the account they sign in to", async () => {
    const put = (playerId: string, key: string, value: unknown, now = 1) => store.putSave("g7", playerId, key, JSON.stringify(value), { maxKeys: 3, now });
    await put("guest:g", "progress", "guest's", 10);
    await put("guest:g", "settings", { sound: false }, 11);
    await put("guest:g", "zzz", 1);
    await put("account:a", "progress", "account's");
    await put("account:a", "extra", 2);
    await store.putSave("g8", "guest:g", "other-game", "1", { maxKeys: 3, now: 1 });
    const score = (playerId: string, board: string, value: number, order: "desc" | "asc", now: number) =>
      store.submitScore("g7", board, { playerId, name: "P", value, public: playerId.startsWith("account:"), order, now });
    await score("account:a", "points", 50, "desc", 1);
    await score("guest:g", "points", 70, "desc", 2);
    await score("account:a", "time", 30, "asc", 3);
    await score("guest:g", "time", 40, "asc", 4);
    await score("guest:g", "only-guest", 5, "desc", 5);
    await store.addScore("g7", "match.wins", { playerId: "account:a", name: "P", delta: 2, public: true, now: 6 });
    await store.addScore("g7", "match.wins", { playerId: "guest:g", name: "P", delta: 3, public: false, now: 7 });
    await store.touch("g7", "guest:g", 8);

    expect(await store.mergeGuest("g7", "guest:g", { playerId: "account:a", name: "Ada" }, { maxKeys: 3, now: 100 })).toEqual({ saves: 1, scores: 4 });
    // The account's own save wins, and the quota leaves the last guest save behind.
    expect(await store.getSave("g7", "account:a", "progress")).toMatchObject({ value: "account's" });
    expect(await store.getSave("g7", "account:a", "settings")).toEqual({ key: "settings", value: { sound: false }, version: 1, updatedAt: 11 });
    expect(await store.getSave("g7", "account:a", "zzz")).toBeUndefined();
    // The better score on each board, the sum of match results, all public under the account's name.
    expect(await store.playerScore("g7", "points", "account:a")).toMatchObject({ score: 70, at: 2, public: true });
    expect(await store.playerScore("g7", "time", "account:a")).toMatchObject({ score: 30, at: 3 });
    expect(await store.playerScore("g7", "match.wins", "account:a")).toMatchObject({ score: 5 });
    expect(await store.topScores("g7", "only-guest", 10, 0)).toEqual([{ rank: 1, playerId: "a", name: "Ada", score: 5, at: 5 }]);
    // The guest keeps nothing in that game, and everything in others.
    expect(await store.listSaves("g7", "guest:g")).toEqual([]);
    expect(await store.playerScore("g7", "points", "guest:g")).toBeUndefined();
    expect(await store.getSave("g8", "guest:g", "other-game")).toBeDefined();
    expect(await store.mergeGuest("g7", "guest:g", { playerId: "account:a", name: "Ada" }, { maxKeys: 3, now: 101 })).toEqual({ saves: 0, scores: 0 });
  });

  it("deletes a player everywhere and prunes players who stopped coming", async () => {
    for (const gameId of ["g3", "g4"]) {
      await store.putSave(gameId, "account:gone", "s", "1", { maxKeys: 5, now: 1 });
      await store.submitScore(gameId, "b", { playerId: "account:gone", name: "G", value: 1, public: true, order: "desc", now: 1 });
      await store.touch(gameId, "account:gone", 1);
    }
    await store.putSave("g3", "account:stays", "s", "1", { maxKeys: 5, now: 1 });
    await store.deletePlayer("account:gone");
    for (const gameId of ["g3", "g4"]) {
      expect(await store.getSave(gameId, "account:gone", "s")).toBeUndefined();
      expect(await store.topScores(gameId, "b", 10, 0)).toEqual([]);
    }
    expect(await store.getSave("g3", "account:stays", "s")).toBeDefined();

    for (const [playerId, seen] of [["guest:old", 100], ["guest:recent", 900], ["account:old", 100], ["account:ancient", 10]] as const) {
      await store.putSave("g5", playerId, "s", "1", { maxKeys: 5, now: seen });
      await store.submitScore("g5", "b", { playerId, name: "P", value: seen, public: playerId.startsWith("account:"), order: "desc", now: seen });
      await store.touch("g5", playerId, seen);
    }
    // Guests go after a shorter absence than accounts.
    await store.prune({ guest: 500, account: 50 });
    expect(await store.getSave("g5", "guest:old", "s")).toBeUndefined();
    expect(await store.playerScore("g5", "b", "guest:old")).toBeUndefined();
    expect(await store.getSave("g5", "guest:recent", "s")).toBeDefined();
    expect(await store.getSave("g5", "account:old", "s")).toBeDefined();
    expect(await store.getSave("g5", "account:ancient", "s")).toBeUndefined();
    expect((await store.topScores("g5", "b", 10, 0)).map((entry) => entry.playerId)).toEqual(["old"]);
  });
});

describe("game data service", () => {
  const ISSUER = "https://accounts.example.test";
  let directory: string;
  let service: ReturnType<typeof createMultiplayerServer>;
  let base: string;
  let sign: (sub: string, name: string, gameId?: string) => Promise<string>;
  const allowed = new Set(["board", "other"]);

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const accountKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256" }] });
    sign = (sub, name, gameId = "board") =>
      new SignJWT({ name })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer(ISSUER)
        .setAudience(gameTokenAudience(gameId))
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(privateKey);
    directory = await mkdtemp(path.join(tmpdir(), "ohmygame-game-data-"));
    service = createMultiplayerServer({
      deployments: [],
      auth: { guestSecret: "a".repeat(32), accountIssuer: ISSUER, accountKeys },
      databasePath: path.join(directory, "rooms.sqlite"),
      host: "127.0.0.1",
      port: 0,
      allowLocalhost: true,
      logger: false,
      gameData: { store: new MemoryGameDataStore(), allowGame: (gameId) => allowed.has(gameId), adminToken: "operator-secret-token" },
    });
    await service.start();
    base = `http://127.0.0.1:${service.port}`;
  });
  afterAll(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
  });

  const call = async (method: string, route: string, token?: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined };
  };
  const guest = async (previous?: string) => (await call("POST", "/v1/guests", previous)).body!.token as string;

  it("saves for a player in one game, and refuses other games, tokens and oversized data", async () => {
    const ada = await sign("ada", "Ada");
    expect((await call("GET", "/v1/games/board/saves/progress", ada)).status).toBe(404);
    const saved = await call("PUT", "/v1/games/board/saves/progress", ada, { value: { level: 4, items: ["key"] } });
    expect(saved).toMatchObject({ status: 200, body: { key: "progress", value: { level: 4, items: ["key"] }, version: 1 } });
    expect((await call("GET", "/v1/games/board/saves/progress", ada)).body).toMatchObject({ value: { level: 4 }, version: 1 });
    expect((await call("PUT", "/v1/games/board/saves/progress", ada, { value: 5, ifVersion: 0 })).body).toMatchObject({ code: "conflict" });
    expect((await call("GET", "/v1/games/board/saves", ada)).body).toEqual([expect.objectContaining({ key: "progress", version: 1 })]);

    // An account token names one game.
    expect((await call("GET", "/v1/games/other/saves", ada)).body).toMatchObject({ code: "not_authorized" });
    expect((await call("GET", "/v1/games/board/saves")).status).toBe(401);
    // A game the service does not keep data for.
    expect((await call("GET", "/v1/games/unpublished/saves", await guest())).body).toMatchObject({ code: "not_found" });

    const big = "x".repeat(SAVE_MAX_BYTES);
    expect(await call("PUT", "/v1/games/board/saves/big", ada, { value: big })).toMatchObject({ status: 413, body: { code: "quota_exceeded" } });
    expect((await call("PUT", "/v1/games/board/saves/bad%20key", ada, { value: 1 })).body).toMatchObject({ code: "invalid_request" });
    expect((await call("PUT", "/v1/games/board/saves/k", ada, { value: 1, extra: true })).body).toMatchObject({ code: "invalid_request" });
    for (let index = 1; index < SAVE_MAX_KEYS; index++)
      expect((await call("PUT", `/v1/games/board/saves/slot-${index}`, ada, { value: index })).status).toBe(200);
    expect(await call("PUT", "/v1/games/board/saves/one-too-many", ada, { value: 1 })).toMatchObject({ status: 413, body: { code: "quota_exceeded" } });
    expect((await call("DELETE", "/v1/games/board/saves/slot-1", ada)).status).toBe(204);
    expect((await call("PUT", "/v1/games/board/saves/one-too-many", ada, { value: 1 })).status).toBe(200);
  });

  it("ranks signed-in players, keeps a guest's score private and limits submissions", async () => {
    const [ada, bo] = [await sign("ada2", "Ada"), await sign("bo", "Bo")];
    const visitor = await guest();
    expect((await call("POST", "/v1/games/board/leaderboards/points/scores", ada, { score: 120 })).body).toEqual({ score: 120, at: expect.any(Number), rank: 1, public: true, improved: true });
    expect((await call("POST", "/v1/games/board/leaderboards/points/scores", bo, { score: 90 })).body).toMatchObject({ rank: 2, improved: true });
    expect((await call("POST", "/v1/games/board/leaderboards/points/scores", visitor, { score: 100 })).body).toMatchObject({ rank: 2, public: false });
    expect((await call("GET", "/v1/games/board/leaderboards/points", visitor)).body).toEqual([
      { rank: 1, playerId: "ada2", name: "Ada", score: 120, at: expect.any(Number) },
      { rank: 2, playerId: "bo", name: "Bo", score: 90, at: expect.any(Number) },
    ]);
    expect((await call("GET", "/v1/games/board/leaderboards/points/me", visitor)).body).toMatchObject({ score: 100, rank: 2, public: false });
    expect((await call("GET", "/v1/games/board/leaderboards/empty/me", visitor)).status).toBe(404);
    expect((await call("POST", "/v1/games/board/leaderboards/points/scores", bo, { score: 1, order: "asc" })).body).toMatchObject({ code: "conflict" });
    expect((await call("POST", "/v1/games/board/leaderboards/points/scores", bo, { score: "lots" })).body).toMatchObject({ code: "invalid_request" });
    expect((await call("GET", "/v1/games/board/leaderboards/points?limit=500", bo)).body).toMatchObject({ code: "invalid_request" });

    // Match boards are the service's to write.
    expect(await call("POST", "/v1/games/board/leaderboards/match.wins/scores", ada, { score: 100 })).toMatchObject({ status: 403, body: { code: "not_authorized" } });
    expect((await call("GET", "/v1/games/board/leaderboards/match.wins", ada)).status).toBe(200);

    const eager = await sign("eager", "Eager");
    for (let index = 0; index < SCORE_SUBMITS_PER_MINUTE; index++)
      expect((await call("POST", "/v1/games/board/leaderboards/points/scores", eager, { score: index })).status).toBe(200);
    expect(await call("POST", "/v1/games/board/leaderboards/points/scores", eager, { score: 99 })).toMatchObject({ status: 429, body: { code: "rate_limited" } });
  });

  it("gives a guest's data to the account they sign in to, only with the guest's token", async () => {
    const visitor = await guest();
    await call("PUT", "/v1/games/board/saves/progress", visitor, { value: "level 3" });
    await call("POST", "/v1/games/board/leaderboards/merged/scores", visitor, { score: 42 });
    const cy = await sign("cy", "Cy");
    expect(await call("POST", "/v1/games/board/merge-guest", visitor, { guestToken: visitor })).toMatchObject({ status: 403, body: { code: "not_authorized" } });
    expect(await call("POST", "/v1/games/board/merge-guest", cy, { guestToken: "guest.forged.token" })).toMatchObject({ status: 401, body: { code: "not_authorized" } });
    expect((await call("POST", "/v1/games/board/merge-guest", cy, { guestToken: visitor, extra: 1 })).status).toBe(400);
    expect(await call("POST", "/v1/games/board/merge-guest", cy, { guestToken: visitor })).toEqual({ status: 200, body: { saves: 1, scores: 1 } });
    expect((await call("GET", "/v1/games/board/saves/progress", cy)).body).toMatchObject({ value: "level 3" });
    expect((await call("GET", "/v1/games/board/saves/progress", visitor)).status).toBe(404);
    expect((await call("GET", "/v1/games/board/leaderboards/merged", cy)).body).toEqual([{ rank: 1, playerId: "cy", name: "Cy", score: 42, at: expect.any(Number) }]);
  });

  it("keeps a returning guest's identity, and deletes an account's data for the operator", async () => {
    const first = await guest();
    await call("PUT", "/v1/games/board/saves/progress", first, { value: "guest progress" });
    // Renewing with the old token keeps the same guest, and their saves.
    const renewed = await guest(first);
    expect((await call("GET", "/v1/games/board/saves/progress", renewed)).body).toMatchObject({ value: "guest progress" });
    expect((await call("GET", "/v1/games/board/saves/progress", await guest())).status).toBe(404);

    const leaving = await sign("leaving", "Leaving");
    await call("PUT", "/v1/games/board/saves/progress", leaving, { value: 1 });
    await call("POST", "/v1/games/board/leaderboards/exit/scores", leaving, { score: 5 });
    expect((await call("DELETE", "/v1/admin/accounts/leaving", "wrong-token-wrong-token")).status).toBe(401);
    expect((await call("DELETE", "/v1/admin/accounts/leaving", "operator-secret-token")).status).toBe(204);
    expect((await call("GET", "/v1/games/board/saves/progress", leaving)).status).toBe(404);
    expect((await call("GET", "/v1/games/board/leaderboards/exit", leaving)).body).toEqual([]);
  });
});

describe("guest renewal", () => {
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
  });

  it("renews an expired guest as the same guest for a while, then as a new one", async () => {
    const auth = new MultiplayerAuth({ guestSecret: "a".repeat(32) });
    const config = { authPolicy: "guest-or-account" as const, gameId: "board" };
    const start = realNow();
    const { token } = auth.issueGuest();
    const id = (await auth.authenticate(token, config)).userId;
    Date.now = () => start + GUEST_TOKEN_MS + 1000;
    await expect(auth.authenticate(token, config)).rejects.toThrow("expired");
    expect((await auth.authenticate(auth.issueGuest(token).token, config)).userId).toBe(id);
    Date.now = () => start + GUEST_TOKEN_MS + GUEST_RENEWAL_MS + 1000;
    expect((await auth.authenticate(auth.issueGuest(token).token, config)).userId).not.toBe(id);
    // A token another service signed starts a new guest.
    const other = new MultiplayerAuth({ guestSecret: "b".repeat(32) }).issueGuest().token;
    expect((await auth.authenticate(auth.issueGuest(other).token, config)).userId).not.toBe(id);
  });
});

describe("published game check", () => {
  it("allows listed games, caches answers and keeps the last answer when the registry is down", async () => {
    const answers: (number | Error)[] = [200, 404, new Error("offline")];
    const requests: string[] = [];
    const check = publishedGameCheck("https://api.example.test", {
      cacheMs: 0,
      fetch: (async (url: URL) => {
        requests.push(url.href);
        const answer = answers.shift()!;
        if (answer instanceof Error) throw answer;
        return new Response(null, { status: answer });
      }) as typeof fetch,
    });
    expect(await check("g1")).toBe(true);
    expect(await check("g2")).toBe(false);
    expect(await check("g1")).toBe(true);
    expect(requests).toEqual([
      "https://api.example.test/v1/published-games/g1",
      "https://api.example.test/v1/published-games/g2",
      "https://api.example.test/v1/published-games/g1",
    ]);
    const cached = publishedGameCheck("https://api.example.test", { fetch: (async () => new Response(null, { status: 200 })) as typeof fetch });
    expect(await cached("g3")).toBe(true);
    await expect(publishedGameCheck("https://api.example.test", { fetch: (async () => new Response(null, { status: 500 })) as typeof fetch })("g4")).rejects.toThrow("registry");
  });
});
