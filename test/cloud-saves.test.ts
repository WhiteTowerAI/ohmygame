import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, isOhMyGameError, SAVE_MAX_BYTES, SAVE_MAX_KEYS, SCORE_SUBMITS_PER_MINUTE, type CloudConfig } from "@ohmygame/sdk";
import { gameTokenAudience } from "@ohmygame/sdk/account-protocol";
import { createMultiplayerServer, MemoryGameDataStore } from "@ohmygame/server";

/** A browser's localStorage, one per simulated browser. */
function browser(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    clear: () => items.clear(),
  };
}

const ISSUER = "https://accounts.example.test";
let directory: string;
let service: ReturnType<typeof createMultiplayerServer>;
let cloud: CloudConfig;
let sign: (sub: string, name: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const accountKeys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256" }] });
  sign = (sub, name) =>
    new SignJWT({ name })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience(gameTokenAudience("puzzle"))
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
  directory = await mkdtemp(path.join(tmpdir(), "ohmygame-cloud-saves-"));
  service = createMultiplayerServer({
    deployments: [],
    auth: { guestSecret: "a".repeat(32), accountIssuer: ISSUER, accountKeys },
    databasePath: path.join(directory, "rooms.sqlite"),
    host: "127.0.0.1",
    port: 0,
    allowLocalhost: true,
    logger: false,
    gameData: { store: new MemoryGameDataStore() },
  });
  await service.start();
  cloud = { serverUrl: `http://127.0.0.1:${service.port}`, gameId: "puzzle" };
});
afterAll(async () => {
  await service.stop();
  await rm(directory, { recursive: true, force: true });
});

/** A game page in one browser: a guest, or signed in when token is given. */
function open(storage: Storage, options: { token?: () => Promise<string>; serverUrl?: string } = {}) {
  return init({
    manifest: { cloud: { ...cloud, ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}) } },
    allowLocalhost: true,
    storage,
    ...(options.token ? { identity: { getToken: options.token } } : {}),
  });
}

describe("cloud saves in the browser SDK", () => {
  it("keeps saves in the browser for a game without a game service", async () => {
    const storage = browser();
    const game = await init({ manifest: {}, storage });
    expect(game.storage.cloud).toBe(false);
    await game.storage.set("progress", { level: 3 });
    await game.storage.set("settings", { sound: false });
    expect(await game.storage.get("progress")).toEqual({ level: 3 });
    expect(await game.storage.keys()).toEqual(["progress", "settings"]);
    await game.storage.remove("settings");
    expect(await game.storage.get("settings")).toBeUndefined();
    // The same browser opens the game again.
    expect(await (await init({ manifest: {}, storage })).storage.get("progress")).toEqual({ level: 3 });
    expect(game.leaderboard.available).toBe(false);
    await expect(game.leaderboard.top("points")).rejects.toMatchObject({ code: "not_configured" });
    await expect(game.storage.set("bad key", 1)).rejects.toMatchObject({ code: "invalid_option" });
    await expect(game.storage.set("fn", () => {})).rejects.toMatchObject({ code: "invalid_option" });
    await expect(game.storage.set("big", "x".repeat(SAVE_MAX_BYTES))).rejects.toMatchObject({ code: "quota_exceeded" });
    await expect(init({ manifest: { cloud: { ...cloud, gameId: "../x" } }, allowLocalhost: true })).rejects.toMatchObject({ code: "not_configured" });
    await expect(init({ manifest: { cloud } })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("saves offline, sends the save once the service is back, and keeps the same guest", async () => {
    const storage = browser();
    // The service cannot be reached: the save stays in the browser.
    const offline = await open(storage, { serverUrl: "http://127.0.0.1:9" });
    await offline.storage.set("progress", { level: 1 });
    expect(await offline.storage.get("progress")).toEqual({ level: 1 });
    expect(await offline.storage.keys()).toEqual(["progress"]);

    const online = await open(storage);
    await online.storage.sync();
    // Another tab of the same browser reads the copy the service now has.
    const service = (await open(browser())).storage;
    expect(await service.get("progress")).toBeUndefined();
    const guestToken = JSON.parse(storage.getItem(`ohmygame:multiplayer:guest:${cloud.serverUrl}`)!).token as string;
    const response = await fetch(`${cloud.serverUrl}/v1/games/puzzle/saves/progress`, { headers: { Authorization: `Bearer ${guestToken}` } });
    expect(await response.json()).toMatchObject({ value: { level: 1 }, version: 1 });

    // An expired guest session renews as the same guest, who still has the save.
    const key = `ohmygame:multiplayer:guest:${cloud.serverUrl}`;
    storage.setItem(key, JSON.stringify({ ...JSON.parse(storage.getItem(key)!), expiresAt: Date.now() - 1000 }));
    for (const name of Object.keys(Object.fromEntries(Array.from({ length: storage.length }, (_, index) => [storage.key(index)!, 1]))))
      if (name.startsWith("ohmygame:save:")) storage.removeItem(name);
    expect(await (await open(storage)).storage.get("progress")).toEqual({ level: 1 });
  });

  it("brings a guest's saves into the account on sign-in and follows the player to another device", async () => {
    const laptop = browser();
    const guest = await open(laptop);
    await guest.storage.set("progress", { level: 7 });
    await guest.storage.set("settings", { music: 0.5 });

    const token = () => sign("ada", "Ada");
    const signedIn = await open(laptop, { token });
    expect(await signedIn.storage.get("progress")).toEqual({ level: 7 });
    await signedIn.storage.set("progress", { level: 8 });

    const phone = await open(browser(), { token });
    expect(await phone.storage.get("progress")).toEqual({ level: 8 });
    // Only what the player read after signing in came along; the rest stays with the guest.
    expect(await phone.storage.keys()).toEqual(["progress"]);
    expect(await phone.storage.get("settings")).toBeUndefined();
    expect(await signedIn.storage.get("settings")).toEqual({ music: 0.5 });
    expect(await phone.storage.keys()).toEqual(["progress", "settings"]);

    // A save the account already has wins over the guest's.
    const other = browser();
    await (await open(other)).storage.set("progress", { level: 1 });
    expect(await (await open(other, { token })).storage.get("progress")).toEqual({ level: 8 });

    await phone.storage.remove("settings");
    expect(await signedIn.storage.get("settings")).toBeUndefined();
  });

  it("reports the service's quota with its code", async () => {
    const game = await open(browser(), { token: () => sign("hoarder", "Hoarder") });
    for (let index = 0; index < SAVE_MAX_KEYS; index++) await game.storage.set(`slot-${index}`, index);
    const refused = await game.storage.set("one-more", 1).catch((cause: unknown) => cause);
    expect(isOhMyGameError(refused, "quota_exceeded")).toBe(true);
    // A refused save does not wait to be sent again.
    await game.storage.sync();
    expect(await game.storage.keys()).toHaveLength(SAVE_MAX_KEYS);
  });
});

describe("leaderboards in the browser SDK", () => {
  it("ranks signed-in players, keeps a guest's score private and reports limits", async () => {
    const ada = await open(browser(), { token: () => sign("lb-ada", "Ada") });
    const bo = await open(browser(), { token: () => sign("lb-bo", "Bo") });
    const guest = await open(browser());
    expect(ada.leaderboard.available).toBe(true);
    expect(await ada.leaderboard.me("points")).toBeUndefined();
    expect(await ada.leaderboard.submit("points", 300)).toMatchObject({ score: 300, rank: 1, public: true, improved: true });
    expect(await bo.leaderboard.submit("points", 200)).toMatchObject({ rank: 2 });
    expect(await ada.leaderboard.submit("points", 100)).toMatchObject({ score: 300, improved: false });
    expect(await guest.leaderboard.submit("points", 250)).toMatchObject({ rank: 2, public: false });
    expect((await guest.leaderboard.top("points")).map(({ playerId, name, score }) => ({ playerId, name, score }))).toEqual([
      { playerId: "lb-ada", name: "Ada", score: 300 },
      { playerId: "lb-bo", name: "Bo", score: 200 },
    ]);
    expect(await bo.leaderboard.top("points", { limit: 1, offset: 1 })).toEqual([expect.objectContaining({ rank: 2, name: "Bo" })]);
    expect(await guest.leaderboard.me("points")).toMatchObject({ score: 250, rank: 2, public: false });

    expect(await ada.leaderboard.submit("time", 42.5, { order: "asc" })).toMatchObject({ score: 42.5 });
    await expect(ada.leaderboard.submit("time", 40)).rejects.toMatchObject({ code: "conflict" });
    await expect(ada.leaderboard.submit("time", Number.NaN)).rejects.toMatchObject({ code: "invalid_option" });
    await expect(ada.leaderboard.top("time", { limit: 1000 })).rejects.toMatchObject({ code: "invalid_option" });

    const eager = await open(browser(), { token: () => sign("lb-eager", "Eager") });
    for (let index = 0; index < SCORE_SUBMITS_PER_MINUTE; index++) await eager.leaderboard.submit("points", index);
    await expect(eager.leaderboard.submit("points", 1)).rejects.toMatchObject({ code: "rate_limited" });
  });
});
