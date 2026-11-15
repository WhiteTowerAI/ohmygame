import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import express, { type Application, type Request, type Response } from "express";
import { exportJWK, SignJWT } from "jose";
import { normalizeDisplayName } from "@ohmygame/sdk/protocol";
import { LOCAL_ACCOUNT_AUDIENCE } from "./auth.js";
import type { MemoryGameDataStore } from "./game-data.js";

/**
 * A stand-in for the OhMyGame account service on a local game service, for local previews
 * and playtests. It speaks the same sign-in protocol as the real one (docs/game-sign-in.md),
 * so a game's sign-in code runs exactly as it will once published, but anyone signs in as
 * any test player by typing a name: the same name is the same player in every browser.
 * Mounted only on a loopback service.
 */
export interface LocalAccounts {
  /** Verifies the tokens it signs. */
  publicKey: KeyObject;
  mount(app: Application): void;
}

const TOKEN_SECONDS = 15 * 60;
const CODE_MS = 60 * 1000;
const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const isLoopbackPage = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.search && !url.hash && !url.username;
  } catch {
    return false;
  }
};
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** A test player's ID: the same for the same name, so two browsers can be one player. */
export function localPlayerId(name: string): string {
  return `local-${sha256(name.toLowerCase()).slice(0, 16)}`;
}

export function createLocalAccounts(): LocalAccounts {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const codes = new Map<string, { player: { id: string; name: string }; redirectUri: string; challenge: string; expiresAt: number }>();
  const sessions = new Map<string, { id: string; name: string } | "used">();
  const back = (redirectUri: string, params: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  };
  const session = async (player: { id: string; name: string }) => {
    const refresh = randomBytes(32).toString("base64url");
    sessions.set(sha256(refresh), player);
    return {
      access_token: await new SignJWT({ name: player.name })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("ohmygame-local")
        .setAudience(LOCAL_ACCOUNT_AUDIENCE)
        .setSubject(player.id)
        .setIssuedAt()
        .setExpirationTime(`${TOKEN_SECONDS}s`)
        .sign(privateKey),
      token_type: "Bearer",
      expires_in: TOKEN_SECONDS,
      refresh_token: refresh,
      player,
    };
  };

  function signInPage(request: Request, response: Response): void {
    const { redirect_uri: redirectUri, state, code_challenge: challenge } = request.query;
    if (!isLoopbackPage(redirectUri) || typeof state !== "string" || state.length > 500) {
      response.status(400).type("text").send("Local sign-in only returns to a game on this computer.");
      return;
    }
    if (request.query.response_type !== "code" || request.query.code_challenge_method !== "S256" || typeof challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      response.redirect(back(redirectUri, { error: "invalid_request", state }));
      return;
    }
    const field = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
    response.type("html").set("cache-control", "no-store").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local test sign-in</title>
<style>body{font:15px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;margin:0;background:#f4f4f5;color:#18181b}
form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 8px 30px #0001;width:min(360px,90vw);display:grid;gap:12px}
h1{font-size:18px;margin:0}p{margin:0;color:#52525b;font-size:13px}input[type=text]{font:inherit;padding:9px 10px;border:1px solid #d4d4d8;border-radius:8px}
div{display:flex;gap:8px}button{flex:1;font:inherit;padding:9px;border-radius:8px;border:0;background:#18181b;color:#fff;cursor:pointer}button[value=cancel]{background:#e4e4e7;color:#18181b}</style></head>
<body><form method="post" action="/v1/game-auth/local-sign-in">
<h1>Local test sign-in</h1>
<p>This stands in for OhMyGame sign-in while the game runs on this computer. Choose any name: the same name is the same test player in every browser.</p>
<input type="text" name="name" value="Test player" maxlength="40" required autofocus>
${field("redirect_uri", redirectUri)}${field("state", state)}${field("code_challenge", challenge)}
<div><button type="submit" name="decision" value="cancel">Cancel</button><button type="submit" name="decision" value="continue">Continue</button></div>
</form></body></html>`);
  }

  return {
    publicKey,
    mount(app) {
      app.get("/v1/game-auth/authorize", signInPage);
      app.post("/v1/game-auth/local-sign-in", express.urlencoded({ extended: false, limit: "4kb" }), (request, response) => {
        const { redirect_uri: redirectUri, state, code_challenge: challenge, name, decision } = request.body as Record<string, unknown>;
        if (!isLoopbackPage(redirectUri) || typeof state !== "string" || typeof challenge !== "string") {
          response.status(400).type("text").send("The sign-in form is incomplete.");
          return;
        }
        if (decision !== "continue") {
          response.redirect(back(redirectUri, { error: "access_denied", state }));
          return;
        }
        const display = normalizeDisplayName(name);
        const code = randomBytes(32).toString("base64url");
        codes.set(sha256(code), { player: { id: localPlayerId(display), name: display }, redirectUri, challenge, expiresAt: Date.now() + CODE_MS });
        response.redirect(back(redirectUri, { code, state }));
      });
      app.post("/v1/game-auth/token", async (request, response) => {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const refuse = (status: number) => response.status(status).json({ error: "invalid_grant" });
        if (body.grant_type === "authorization_code" && typeof body.code === "string" && typeof body.code_verifier === "string") {
          const key = sha256(body.code);
          const code = codes.get(key);
          codes.delete(key);
          if (!code || code.expiresAt < Date.now() || code.redirectUri !== body.redirect_uri || sha256(body.code_verifier) !== code.challenge) return refuse(400);
          response.json(await session(code.player));
          return;
        }
        if (body.grant_type === "refresh_token" && typeof body.refresh_token === "string") {
          const key = sha256(body.refresh_token);
          const player = sessions.get(key);
          if (!player || player === "used") return refuse(401);
          sessions.set(key, "used");
          response.json(await session(player));
          return;
        }
        response.status(400).json({ error: "unsupported_grant_type" });
      });
      app.get("/v1/game-auth/jwks.json", async (_request, response) => {
        response.json({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", use: "sig" }] });
      });
    },
  };
}

/**
 * Local development only: a page that shows what the local service keeps for a game, its
 * leaderboards with every entry and who has saves, so a developer can see them without
 * building a screen into the game.
 */
export function mountGameDataViewer(app: Application, store: MemoryGameDataStore): void {
  app.get("/dev/games/:gameId", (request, response) => {
    const gameId = String(request.params.gameId);
    const { boards, saves } = store.describe(gameId);
    const rows = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    const boardHtml = boards.length
      ? boards.map(({ board, order, entries }) => `<h2>${escape(board)} <small>${order === "desc" ? "higher first" : "lower first"}</small></h2>
<table><tr><th>Rank</th><th>Player</th><th>Score</th><th>Shown</th></tr>${entries.map((entry, index) =>
          rows([String(index + 1), escape(`${entry.name} (${entry.playerId})`), String(entry.score), entry.public ? "publicly" : "to the player only (guest)"])).join("")}</table>`).join("")
      : "<p>No scores yet.</p>";
    const saveHtml = saves.length
      ? `<table><tr><th>Player</th><th>Saves</th></tr>${saves.map((save) => rows([escape(save.playerId), escape(save.keys.join(", "))])).join("")}</table>`
      : "<p>No saves yet.</p>";
    response.type("html").set("cache-control", "no-store").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escape(gameId)} · local game data</title><meta http-equiv="refresh" content="5">
<style>body{font:14px system-ui,sans-serif;margin:32px;color:#18181b}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #e4e4e7;padding:6px 10px;text-align:left}small{color:#71717a;font-weight:400;font-size:12px}</style></head>
<body><h1>Local game data: ${escape(gameId)}</h1><p>Kept in memory by OhMyGame's local game service until OhMyGame quits. Refreshes every five seconds.</p>
<h1>Leaderboards</h1>${boardHtml}<h1>Saves</h1>${saveHtml}</body></html>`);
  });
}
