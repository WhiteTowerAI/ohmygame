import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { init } from "@ohmygame/sdk";
import { createMultiplayerClient } from "@ohmygame/sdk/multiplayer";
import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { createBuiltInAdapters } from "@ohmygame/games";
import type { AccountEnvironment } from "../packages/sdk/src/account.js";
import { createMultiplayerServer, MemoryGameDataStore } from "@ohmygame/server";
import { localPlayerId } from "../packages/server/src/local-accounts.js";
import { LocalMultiplayerRuntime } from "../src/daemon/local-multiplayer.js";

const PREVIEW = "http://127.0.0.1:5173";

function browserStorage(): Storage {
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

let directory: string;
let service: ReturnType<typeof createMultiplayerServer>;
let base: string;
const rooms: MultiplayerManifestConfig = {
  enabled: true,
  mode: "turn-based",
  gameId: "puzzle",
  deploymentId: "v1",
  protocolVersion: 1,
  serverUrl: "https://games.example.test",
  authPolicy: "guest-or-account",
  roomPolicy: "invite-or-public",
  maxClients: 2,
  reconnectSeconds: 2,
  adapterId: "stones",
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-accounts-"));
  service = createMultiplayerServer({
    deployments: [rooms],
    adapters: createBuiltInAdapters(),
    auth: { guestSecret: "a".repeat(32) },
    databasePath: path.join(directory, "rooms.sqlite"),
    host: "127.0.0.1",
    port: 0,
    allowLocalhost: true,
    logger: false,
    gameData: { store: new MemoryGameDataStore() },
    localAccounts: true,
  });
  await service.start();
  base = `http://127.0.0.1:${service.port}`;
});
afterAll(async () => {
  await service.stop();
  await rm(directory, { recursive: true, force: true });
});

/**
 * One browser with the game open in a local preview. Popups are blocked, so sign-in goes to
 * the local sign-in page and back, which the test does as the player would.
 */
function browser() {
  const storage = browserStorage();
  const page = { href: `${PREVIEW}/`, assigned: [] as string[] };
  const env: AccountEnvironment = {
    fetch: (url, init) => fetch(url, init),
    storage,
    location: {
      get href() {
        return page.href;
      },
      origin: PREVIEW,
      assign: (url) => void page.assigned.push(url),
    },
    replaceUrl: (url) => {
      page.href = url;
    },
    openPopup: () => null,
    opener: null,
    parent: null,
    close: () => {},
    listen: () => () => {},
    crypto: globalThis.crypto,
    now: () => Date.now(),
  };
  const open = () =>
    init({
      manifest: { account: { issuer: base }, cloud: { serverUrl: `${base}/`, gameId: "puzzle" } },
      allowLocalhost: true,
      storage,
      accountEnvironment: env,
    });
  /** Signs in as name on the local sign-in page; resolves with the game after it comes back. */
  const signIn = async (name: string, decision = "continue") => {
    const game = await open();
    void game.auth.signIn();
    await expect.poll(() => page.assigned.length).toBeGreaterThan(0);
    const authorize = new URL(page.assigned.pop()!);
    expect(authorize.origin + authorize.pathname).toBe(`${base}/v1/game-auth/authorize`);
    const form = await fetch(authorize);
    expect(await form.text()).toContain("Local test sign-in");
    const submitted = await fetch(`${base}/v1/game-auth/local-sign-in`, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        name,
        decision,
        redirect_uri: authorize.searchParams.get("redirect_uri")!,
        state: authorize.searchParams.get("state")!,
        code_challenge: authorize.searchParams.get("code_challenge")!,
      }),
    });
    expect(submitted.status).toBe(302);
    page.href = submitted.headers.get("location")!;
    // The page loads again at the address the sign-in page returned to.
    return open();
  };
  return { page, open, signIn };
}

describe("local test accounts", () => {
  it("signs a test player in through the real protocol, then saves and ranks them as an account", async () => {
    const laptop = browser();
    const guest = await laptop.open();
    expect(guest.auth.available).toBe(true);
    expect(guest.storage.cloud).toBe(true);
    await guest.storage.set("progress", { level: 3 });

    const game = await laptop.signIn("Ada");
    expect(game.auth.player).toEqual({ id: localPlayerId("Ada"), name: "Ada" });
    expect(laptop.page.href).toBe(`${PREVIEW}/`);
    // The guest's progress moves into the test account, which follows the name to another browser.
    expect(await game.storage.get("progress")).toEqual({ level: 3 });
    expect(await game.leaderboard.submit("points", 120)).toMatchObject({ rank: 1, public: true });
    // In a room, a signed-in player who names no one shows as their account.
    const room = createMultiplayerClient({ ...game, multiplayer: { ...rooms, serverUrl: base } }, {}, { storage: browserStorage(), identityStorage: browserStorage() });
    try {
      await room.createRoom();
      await vi.waitFor(() => expect(room.snapshot?.state.players.map((player) => player.displayName)).toEqual(["Ada"]));
    } finally {
      room.dispose();
    }

    const phone = await browser().signIn("ada");
    expect(phone.auth.player?.id).toBe(localPlayerId("Ada"));
    expect(await phone.storage.get("progress")).toEqual({ level: 3 });

    const bo = await browser().signIn("Bo");
    await bo.leaderboard.submit("points", 90);
    await (await browser().open()).leaderboard.submit("points", 500);
    expect((await bo.leaderboard.top("points")).map(({ name, score }) => [name, score])).toEqual([["Ada", 120], ["Bo", 90]]);

    // The local viewer shows every score, guests' too, and who keeps saves.
    const viewer = await (await fetch(`${base}/dev/games/puzzle`)).text();
    expect(viewer).toContain("Ada (" + localPlayerId("Ada") + ")");
    expect(viewer).toContain("to the player only (guest)");
    expect(viewer).toContain("progress");
  });

  it("returns a cancelled sign-in to the game, and refuses pages off this computer", async () => {
    const cancelled = browser();
    const game = await cancelled.signIn("Ada", "cancel");
    expect(game.auth.player).toBeUndefined();
    expect(cancelled.page.href).toBe(`${PREVIEW}/`);

    const outside = await fetch(`${base}/v1/game-auth/authorize?${new URLSearchParams({
      response_type: "code",
      redirect_uri: "https://evil.example/",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      state: "s",
    })}`, { redirect: "manual" });
    expect(outside.status).toBe(400);
  });

  it("comes with OhMyGame's local service, which games reach from their manifest", async () => {
    const runtime = new LocalMultiplayerRuntime(0);
    try {
      const services = await runtime.gameServices("project-1");
      expect(services.cloud).toEqual({ serverUrl: `${services.account.issuer}/`, gameId: "project-1" });
      const game = await init({ manifest: services, allowLocalhost: true, storage: browserStorage() });
      expect(game.storage.cloud).toBe(true);
      await game.storage.set("progress", 1);
      await game.leaderboard.submit("points", 7);
      expect(await (await fetch(`${services.cloud.serverUrl}dev/games/project-1`)).text()).toContain("points");
      // Multiplayer and game data share the one service.
      const rooms = await runtime.configure("project-1", "stones");
      expect(rooms.serverUrl).toBe(services.account.issuer);
    } finally {
      await runtime.close();
    }
  });

  it("is only for a local service", () => {
    expect(() => createMultiplayerServer({
      deployments: [],
      auth: { guestSecret: "a".repeat(32) },
      databasePath: ":memory:",
      localAccounts: true,
    })).toThrow("only for a local service");
  });
});
