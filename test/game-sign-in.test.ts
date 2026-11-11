import { createHash } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { init } from "@ohmygame/sdk";
import type { AccountEnvironment } from "../packages/sdk/src/account.js";
import { gameTokenAudience } from "@ohmygame/sdk/account-protocol";
import { MultiplayerAuth } from "../packages/server/src/auth.js";

const ISSUER = "https://accounts.example.test";
const GAME = "https://g-3f1e2d4c-0000-4000-8000-000000000001.play.example.test";
const player = { id: "6a1d0b52-90c3-4cf3-9c4d-1b8a2e1f0a77", name: "Ada" };

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
    key: (index) => [...entries.keys()][index] ?? null,
  };
}

/** A browser for one page of the game, sharing storage and an account service with other pages. */
function browser(
  storage: Storage,
  service: (body: Record<string, string>) => Response,
  options: { href?: string; opener?: boolean; parent?: boolean; popup?: boolean } = {},
) {
  const listeners = new Set<(message: { data: unknown; origin: string; source: unknown }) => void>();
  const watchers = new Set<(key: string | null) => void>();
  const page = {
    href: options.href ?? `${GAME}/`,
    assigned: [] as string[],
    opened: [] as string[],
    sentToOpener: [] as unknown[],
    sentToParent: [] as { message: unknown; origin: string }[],
    closed: false,
    now: 1_000_000,
    popup: { closed: false, postMessage() {} },
    parent: { postMessage: (message: unknown, origin: string) => void page.sentToParent.push({ message, origin }) },
    /** Delivers a message to this page, as window.postMessage would. */
    receive(data: unknown, origin: string, source: unknown) {
      for (const listener of [...listeners]) listener({ data, origin, source });
    },
    /** Tells this page another tab changed storage, as the storage event would. */
    storageChanged(key: string | null) {
      for (const watcher of [...watchers]) watcher(key);
    },
  };
  const env: AccountEnvironment = {
    fetch: async (url, init) => {
      expect(String(url)).toBe(`${ISSUER}/v1/game-auth/token`);
      return service(JSON.parse(String(init?.body)));
    },
    storage,
    location: {
      get href() {
        return page.href;
      },
      origin: GAME,
      assign: (url) => void page.assigned.push(url),
    },
    replaceUrl: (url) => {
      page.href = url;
    },
    openPopup: (url) => {
      page.opened.push(url);
      return options.popup === false ? null : page.popup;
    },
    opener: options.opener ? { postMessage: (message) => void page.sentToOpener.push(message) } : null,
    parent: options.parent ? page.parent : null,
    close: () => {
      page.closed = true;
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watchStorage(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    crypto: globalThis.crypto,
    now: () => page.now,
  };
  return { page, env };
}

/** An account service that checks PKCE and rotates refresh tokens. */
function accountService() {
  const challenges = new Map<string, { challenge: string; redirectUri: string }>();
  let issued = 0;
  const live = new Set<string>();
  const session = () => {
    const refresh = `refresh-${++issued}`;
    live.add(refresh);
    return Response.json({ access_token: `token-${issued}`, token_type: "Bearer", expires_in: 900, refresh_token: refresh, player });
  };
  return {
    /** What the sign-in page does: remembers the challenge and returns a code. */
    authorize(url: string) {
      const request = new URL(url);
      expect(request.origin + request.pathname).toBe(`${ISSUER}/v1/game-auth/authorize`);
      expect(request.searchParams.get("code_challenge_method")).toBe("S256");
      const code = `code-${challenges.size + 1}`;
      challenges.set(code, {
        challenge: request.searchParams.get("code_challenge")!,
        redirectUri: request.searchParams.get("redirect_uri")!,
      });
      return { code, state: request.searchParams.get("state")!, redirectUri: request.searchParams.get("redirect_uri")! };
    },
    handle(body: Record<string, string>): Response {
      if (body.grant_type === "authorization_code") {
        const expected = challenges.get(body.code!);
        challenges.delete(body.code!);
        const verified = expected &&
          createHash("sha256").update(body.code_verifier!).digest("base64url") === expected.challenge &&
          body.redirect_uri === expected.redirectUri;
        return verified ? session() : Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      if (body.grant_type === "refresh_token" && live.delete(body.refresh_token!)) return session();
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    },
    revokeAll: () => live.clear(),
  };
}

const manifest = { account: { issuer: ISSUER } };

describe("game sign-in in the SDK", () => {
  it("plays as a guest in a local build, where sign-in is unavailable", async () => {
    const { env } = browser(memoryStorage(), () => Response.json({}));
    const game = await init({ manifest: {}, accountEnvironment: env });
    expect(game.auth.available).toBe(false);
    expect(game.auth.player).toBeUndefined();
    expect(await game.auth.getToken()).toBeUndefined();
    await expect(game.auth.signIn()).rejects.toMatchObject({ code: "unsupported" });
    expect(game.identity).toBeUndefined();
    await expect(init({ manifest: { account: { issuer: "http://accounts.example.test" } }, accountEnvironment: env }))
      .rejects.toMatchObject({ code: "not_configured" });
  });

  it("signs in through a popup with PKCE, then renews and signs out when the account service refuses", async () => {
    const service = accountService();
    const storage = memoryStorage();
    const { page, env } = browser(storage, (body) => service.handle(body), { href: `${GAME}/?level=2#map` });
    const game = await init({ manifest, accountEnvironment: env });
    expect(game.auth.available).toBe(true);
    expect(game.identity).toBe(game.auth);
    const signingIn = game.auth.signIn();
    await vi.waitFor(() => expect(page.opened).toHaveLength(1));
    const { code, state, redirectUri } = service.authorize(page.opened[0]!);
    expect(redirectUri).toBe(`${GAME}/`);
    // Neither another origin nor another window can answer the popup.
    page.receive({ type: "ohmygame:sign-in", code, state }, "https://evil.example.test", page.popup);
    page.receive({ type: "ohmygame:sign-in", code, state }, GAME, {});
    page.receive({ type: "ohmygame:sign-in", code, state }, GAME, page.popup);
    await expect(signingIn).resolves.toEqual(player);
    expect(game.auth.player).toEqual(player);
    expect(await game.auth.getToken()).toBe("token-1");

    // Near expiry the token renews, and the rotated session is what a reload finds.
    page.now += 890_000;
    expect(await game.auth.getToken()).toBe("token-2");
    const reloaded = await init({ manifest, accountEnvironment: browser(storage, (body) => service.handle(body)).env });
    expect(reloaded.auth.player).toEqual(player);

    // Signing out of OhMyGame ends the game's session at the next renewal.
    service.revokeAll();
    page.now += 900_000;
    expect(await game.auth.getToken()).toBeUndefined();
    expect(game.auth.player).toBeUndefined();
  });

  it("signs out in every tab, tells each page's listeners, and drops a renewal that was on its way", async () => {
    const service = accountService();
    const storage = memoryStorage();
    const first = browser(storage, (body) => service.handle(body));
    const second = browser(storage, (body) => service.handle(body));
    const [game, other] = [await init({ manifest, accountEnvironment: first.env }), await init({ manifest, accountEnvironment: second.env })];
    const [heard, otherHeard] = [[] as unknown[], [] as unknown[]];
    game.auth.onAuthChange((changed) => heard.push(changed));
    const stopOther = other.auth.onAuthChange((changed) => otherHeard.push(changed));

    const signingIn = game.auth.signIn();
    await vi.waitFor(() => expect(first.page.opened).toHaveLength(1));
    const { code, state } = service.authorize(first.page.opened[0]!);
    first.page.receive({ type: "ohmygame:sign-in", code, state }, GAME, first.page.popup);
    await signingIn;
    expect(heard).toEqual([player]);
    // The other tab hears of it through storage.
    second.page.storageChanged(`ohmygame:account:${ISSUER}`);
    expect(other.auth.player).toEqual(player);
    expect(otherHeard).toEqual([player]);
    // A renewal is the same player: nobody hears of it.
    first.page.now += 890_000;
    expect(await game.auth.getToken()).toBe("token-2");
    expect(heard).toEqual([player]);

    await game.auth.signOut();
    expect(game.auth.player).toBeUndefined();
    expect(await game.auth.getToken()).toBeUndefined();
    expect(heard).toEqual([player, undefined]);
    // The other tab is signed out too; a listener that stopped hears nothing.
    stopOther();
    second.page.storageChanged(`ohmygame:account:${ISSUER}`);
    expect(other.auth.player).toBeUndefined();
    expect(otherHeard).toEqual([player]);

    // A renewal that was on its way when the player signed out does not sign them back in.
    const slow = accountService();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const third = browser(memoryStorage(), (body) => slow.handle(body));
    const late = await init({
      manifest,
      accountEnvironment: {
        ...third.env,
        fetch: async (url, init) => {
          if (JSON.parse(String(init?.body)).grant_type === "refresh_token") await gate;
          return third.env.fetch(url, init);
        },
      },
    });
    const lateSignIn = late.auth.signIn();
    await vi.waitFor(() => expect(third.page.opened).toHaveLength(1));
    const grant = slow.authorize(third.page.opened[0]!);
    third.page.receive({ type: "ohmygame:sign-in", code: grant.code, state: grant.state }, GAME, third.page.popup);
    await lateSignIn;
    third.page.now += 890_000;
    const token = late.auth.getToken();
    await late.auth.signOut();
    release();
    expect(await token).toBeUndefined();
    expect(late.auth.player).toBeUndefined();
  });

  it("renews in one tab at a time, so two tabs never spend one refresh token", async () => {
    const service = accountService();
    const storage = memoryStorage();
    const renewals: string[] = [];
    const handle = (body: Record<string, string>) => {
      if (body.grant_type === "refresh_token") renewals.push(body.refresh_token!);
      return service.handle(body);
    };
    // navigator.locks, shared by every tab of the browser.
    const held = new Map<string, Promise<unknown>>();
    const exclusive = <T>(name: string, task: () => Promise<T>): Promise<T> => {
      const run = (held.get(name) ?? Promise.resolve()).then(task, task);
      held.set(name, run.catch(() => {}));
      return run;
    };
    const first = browser(storage, handle);
    const second = browser(storage, handle);
    first.env.exclusive = exclusive;
    second.env.exclusive = exclusive;
    const tab = await init({ manifest, accountEnvironment: first.env });
    const signingIn = tab.auth.signIn();
    await vi.waitFor(() => expect(first.page.opened).toHaveLength(1));
    const { code, state } = service.authorize(first.page.opened[0]!);
    first.page.receive({ type: "ohmygame:sign-in", code, state }, GAME, first.page.popup);
    await signingIn;
    const other = await init({ manifest, accountEnvironment: second.env });
    expect(other.auth.player).toEqual(player);

    // Both tabs find the token about to expire at the same moment.
    first.page.now += 890_000;
    second.page.now += 890_000;
    const [a, b] = await Promise.all([tab.auth.getToken(), other.auth.getToken()]);
    expect(renewals).toEqual(["refresh-1"]);
    expect([a, b]).toEqual(["token-2", "token-2"]);
    expect(tab.auth.player).toEqual(player);
    expect(other.auth.player).toEqual(player);
  });

  it("reports a closed popup as cancelled", async () => {
    const { page, env } = browser(memoryStorage(), () => Response.json({}));
    const game = await init({ manifest, accountEnvironment: env });
    const signingIn = game.auth.signIn();
    await vi.waitFor(() => expect(page.opened).toHaveLength(1));
    page.popup.closed = true;
    await expect(signingIn).rejects.toMatchObject({ code: "cancelled" });
  });

  it("signs in on the page itself when the popup is blocked, and finishes when it returns", async () => {
    const service = accountService();
    const storage = memoryStorage();
    const { page, env } = browser(storage, (body) => service.handle(body), { popup: false });
    const game = await init({ manifest, accountEnvironment: env });
    void game.auth.signIn();
    await vi.waitFor(() => expect(page.assigned).toHaveLength(1));
    const { code, state } = service.authorize(page.assigned[0]!);

    const back = browser(storage, (body) => service.handle(body), { href: `${GAME}/?code=${code}&state=${state}&level=2` });
    const returned = await init({ manifest, accountEnvironment: back.env });
    expect(returned.auth.player).toEqual(player);
    expect(back.page.href).toBe(`${GAME}/?level=2`);
    // A response this page did not ask for is ignored.
    const forged = browser(memoryStorage(), (body) => service.handle(body), { href: `${GAME}/?code=${code}&state=${state}` });
    expect((await init({ manifest, accountEnvironment: forged.env })).auth.player).toBeUndefined();
  });

  it("hands the code back from the popup and never starts the game there", async () => {
    const service = accountService();
    const storage = memoryStorage();
    const { page, env } = browser(storage, (body) => service.handle(body));
    const game = await init({ manifest, accountEnvironment: env });
    const signingIn = game.auth.signIn();
    await vi.waitFor(() => expect(page.opened).toHaveLength(1));
    const { code, state } = service.authorize(page.opened[0]!);

    const popup = browser(storage, (body) => service.handle(body), { href: `${GAME}/?code=${code}&state=${state}`, opener: true });
    let started = false;
    void init({ manifest, accountEnvironment: popup.env }).then(() => (started = true));
    await vi.waitFor(() => expect(popup.page.sentToOpener).toEqual([{ type: "ohmygame:sign-in", state, code }]));
    expect(popup.page.closed).toBe(true);
    page.receive(popup.page.sentToOpener[0], GAME, page.popup);
    await expect(signingIn).resolves.toEqual(player);
    expect(started).toBe(false);
  });

  it("finishes in a popup cut off from the game, which finds the player when it closes", async () => {
    const service = accountService();
    const storage = memoryStorage();
    const { page, env } = browser(storage, (body) => service.handle(body));
    const game = await init({ manifest, accountEnvironment: env });
    const signingIn = game.auth.signIn();
    await vi.waitFor(() => expect(page.opened).toHaveLength(1));
    const { code, state } = service.authorize(page.opened[0]!);
    const popup = browser(storage, (body) => service.handle(body), { href: `${GAME}/?code=${code}&state=${state}` });
    void init({ manifest, accountEnvironment: popup.env });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(popup.page.closed).toBe(true);
    page.popup.closed = true;
    await expect(signingIn).resolves.toEqual(player);
  });

  it("takes the player from an embedding OhMyGame page, and from no other", async () => {
    const storage = memoryStorage();
    const { page, env } = browser(storage, () => Response.json({}), { parent: true });
    const game = await init({ manifest, accountEnvironment: env });
    expect(page.sentToParent).toEqual([{ message: { type: "ohmygame:account-request" }, origin: ISSUER }]);
    const session = { access_token: "handed", expires_in: 900, player };
    page.receive({ type: "ohmygame:account", session }, "https://evil.example.test", page.parent);
    page.receive({ type: "ohmygame:account", session }, ISSUER, {});
    page.receive({ type: "ohmygame:account", session }, ISSUER, page.parent);
    expect(await game.auth.getToken()).toBe("handed");
    expect(game.auth.player).toEqual(player);

    // Signed out, a reload no longer asks the embedding page, until the player signs in again.
    await game.auth.signOut();
    const reloaded = browser(storage, () => Response.json({}), { parent: true });
    const again = await init({ manifest, accountEnvironment: reloaded.env });
    expect(reloaded.page.sentToParent).toEqual([]);
    expect(await again.auth.getToken()).toBeUndefined();
    const signingIn = again.auth.signIn();
    await vi.waitFor(() => expect(reloaded.page.sentToParent).toHaveLength(1));
    reloaded.page.receive({ type: "ohmygame:account", session }, ISSUER, reloaded.page.parent);
    await expect(signingIn).resolves.toEqual(player);
  });
});

describe("game tokens on the multiplayer service", () => {
  async function keys() {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256" }] });
    const sign = (claims: { aud?: string; iss?: string; sub?: string; exp?: string } = {}) =>
      new SignJWT({ name: player.name })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer(claims.iss ?? ISSUER)
        .setAudience(claims.aud ?? gameTokenAudience("board"))
        .setSubject(claims.sub ?? player.id)
        .setIssuedAt()
        .setExpirationTime(claims.exp ?? "15m")
        .sign(privateKey);
    return { jwks, sign };
  }
  const board = { gameId: "board", authPolicy: "account-required" as const };

  it("accepts a token for this game and refuses one for another game, issuer or time", async () => {
    const { jwks, sign } = await keys();
    const auth = new MultiplayerAuth({ guestSecret: "a".repeat(32), accountIssuer: `${ISSUER}/`, accountKeys: jwks });
    await expect(auth.authenticate(await sign(), board)).resolves.toEqual({ kind: "account", userId: `account:${player.id}`, name: player.name });
    await expect(auth.authenticate(await sign(), { ...board, authPolicy: "guest-or-account" })).resolves.toMatchObject({ kind: "account" });
    for (const token of [
      await sign({ aud: gameTokenAudience("other") }),
      await sign({ iss: "https://elsewhere.example.test" }),
      await sign({ exp: "-1m" }),
      await sign({ sub: "../admin" }),
    ])
      await expect(auth.authenticate(token, board)).rejects.toThrow("invalid, expired or for another game");
    // Another key, even with the right claims, is not the account service's.
    await expect(auth.authenticate(await (await keys()).sign(), board)).rejects.toThrow("invalid");
    await expect(auth.authenticate(await sign(), { ...board, authPolicy: "anonymous" })).rejects.toThrow("only accepts guests");
  });

  it("accepts only guests without an account service, and only HTTPS issuers", async () => {
    const { sign } = await keys();
    const guestsOnly = new MultiplayerAuth({ guestSecret: "a".repeat(32) });
    await expect(guestsOnly.authenticate(await sign(), board)).rejects.toThrow("not configured");
    const { token } = guestsOnly.issueGuest();
    await expect(guestsOnly.authenticate(token, { ...board, authPolicy: "guest-or-account" })).resolves.toMatchObject({ kind: "guest" });
    expect(() => new MultiplayerAuth({ guestSecret: "a".repeat(32), accountIssuer: "http://accounts.example.test" })).toThrow("HTTPS");
  });
});
