// The contract between games, the OhMyGame account service and game services for signing
// players in. docs/game-sign-in.md describes the endpoints the account service provides.
import { isRecord } from "./multiplayer-protocol.js";

/** Where a published game signs players in, written to manifest.json as "account" by OhMyGame publishing. */
export interface GameAccountConfig {
  /** The OhMyGame account service, such as https://api.ohmygame.ai. */
  issuer: string;
  /**
   * Pages that may embed the game and hand it the signed-in player, such as OhMyGame's game
   * page. Defaults to the issuer's origin.
   */
  hostOrigins?: string[];
}

/** The player a game token names: the OhMyGame account ID and the name to show. */
export interface OhMyGamePlayer {
  id: string;
  name: string;
}

/** The audience of a game token: the one game it signs a player in to. */
export function gameTokenAudience(gameId: string): string {
  return `ohmygame:game:${gameId}`;
}

function isOrigin(value: unknown, allowLocalhost: boolean): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (allowLocalhost && loopback && url.protocol === "http:")) &&
      url.origin === value.replace(/\/$/, "");
  } catch {
    return false;
  }
}

export function isGameAccountConfig(
  value: unknown,
  options: { allowLocalhost?: boolean } = {},
): value is GameAccountConfig {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "issuer" && key !== "hostOrigins")) return false;
  const local = options.allowLocalhost === true;
  if (typeof value.issuer !== "string") return false;
  try {
    const issuer = new URL(value.issuer);
    if (!isOrigin(issuer.origin, local) || issuer.username || issuer.password || issuer.search || issuer.hash) return false;
  } catch {
    return false;
  }
  return value.hostOrigins === undefined ||
    (Array.isArray(value.hostOrigins) && value.hostOrigins.length <= 8 && value.hostOrigins.every((origin) => isOrigin(origin, local)));
}

export function isOhMyGamePlayer(value: unknown): value is OhMyGamePlayer {
  return isRecord(value) &&
    typeof value.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.id) &&
    typeof value.name === "string" && value.name.length <= 100;
}
