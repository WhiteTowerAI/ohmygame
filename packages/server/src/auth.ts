import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { normalizeDisplayName } from "@ohmygame/sdk/protocol";
import type { KeyObject } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { gameTokenAudience } from "@ohmygame/sdk/account-protocol";
import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";

export interface MultiplayerIdentity {
  userId: string;
  kind: "account" | "guest";
  /** An account's display name, from its game token. */
  name?: string;
}
/** How long a guest token is valid. */
export const GUEST_TOKEN_MS = 24 * 60 * 60 * 1000;
/** How long after a guest token expires it may still be renewed as the same guest. */
export const GUEST_RENEWAL_MS = 30 * 24 * 60 * 60 * 1000;
export interface MultiplayerAuthOptions {
  guestSecret: string;
  /**
   * The OhMyGame account service that signs game tokens, such as https://api.ohmygame.ai.
   * Without it the service accepts guests only. See docs/game-sign-in.md.
   */
  accountIssuer?: string;
  /** Signing keys for tests; defaults to the issuer's /v1/game-auth/jwks.json. */
  accountKeys?: JWTVerifyGetKey;
  /**
   * Local development only: the key of this service's own test account service, whose
   * tokens sign in test players to every local game. See local-accounts.ts.
   */
  localAccountKey?: KeyObject;
}

/** The audience of a local test account token: any game on the local service. */
export const LOCAL_ACCOUNT_AUDIENCE = "ohmygame:game:local";

export class MultiplayerAuth {
  private readonly issuer?: string;
  private readonly keys?: JWTVerifyGetKey;

  constructor(private readonly options: MultiplayerAuthOptions) {
    if (Buffer.byteLength(options.guestSecret) < 32)
      throw new Error(
        "MULTIPLAYER_GUEST_SECRET must contain at least 32 bytes.",
      );
    if (options.accountIssuer) {
      this.issuer = options.accountIssuer.replace(/\/+$/, "");
      if (new URL(this.issuer).protocol !== "https:" && !options.accountKeys)
        throw new Error("The account issuer must use HTTPS.");
      this.keys = options.accountKeys ?? createRemoteJWKSet(new URL(`${this.issuer}/v1/game-auth/jwks.json`));
    }
  }
  /**
   * A new guest, or the same guest again when previous is one of this service's guest
   * tokens that expired no more than GUEST_RENEWAL_MS ago, so a returning guest keeps
   * their saves and scores.
   */
  issueGuest(previous?: string): { token: string; expiresAt: number } {
    const now = Date.now();
    const expiresAt = now + GUEST_TOKEN_MS;
    const known = previous ? this.readGuest(previous) : undefined;
    const id = known && known.expiresAt + GUEST_RENEWAL_MS > now ? known.id : randomUUID();
    const payload = Buffer.from(
      JSON.stringify({ id, expiresAt }),
    ).toString("base64url");
    return {
      token: `guest.${payload}.${this.sign(payload).toString("base64url")}`,
      expiresAt,
    };
  }
  /** The player a token names for this deployment: a guest, or an account signed in to this game. */
  async authenticate(
    token: string | undefined,
    config: Pick<MultiplayerManifestConfig, "authPolicy" | "gameId">,
  ): Promise<MultiplayerIdentity> {
    const policy = config.authPolicy;
    if (!token || token.length > 10_000)
      throw new Error("A valid player token is required.");
    if (token.startsWith("guest.")) {
      if (policy === "account-required")
        throw new Error("Account sign-in is required.");
      const claims = this.readGuest(token);
      if (!claims || claims.expiresAt <= Date.now())
        throw new Error("The guest token is invalid or expired.");
      return { kind: "guest", userId: `guest:${claims.id}` };
    }
    if (policy === "anonymous")
      throw new Error("This game only accepts guests.");
    const local = this.options.localAccountKey && await this.localAccount(token);
    if (local) return local;
    if (!this.issuer || !this.keys)
      throw new Error("OhMyGame accounts are not configured on the multiplayer service.");
    // A game token is signed by the account service for one game; the deployment's gameId is that game.
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: gameTokenAudience(config.gameId),
        algorithms: ["ES256"],
        requiredClaims: ["sub", "exp"],
      });
      if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.sub)) throw new Error();
      return {
        kind: "account",
        userId: `account:${payload.sub}`,
        ...(typeof payload.name === "string" ? { name: normalizeDisplayName(payload.name) } : {}),
      };
    } catch {
      throw new Error("The account token is invalid, expired or for another game.");
    }
  }
  /**
   * The player ID of the guest a token names, while that guest could still be renewed:
   * their data stays that long, so a player signing in after a while away keeps it.
   */
  renewableGuest(token: string): string | undefined {
    const claims = this.readGuest(token);
    return claims && claims.expiresAt + GUEST_RENEWAL_MS > Date.now() ? `guest:${claims.id}` : undefined;
  }
  /** A test player from this service's local account service, when the token is one. */
  private async localAccount(token: string): Promise<MultiplayerIdentity | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.options.localAccountKey!, {
        audience: LOCAL_ACCOUNT_AUDIENCE,
        algorithms: ["ES256"],
        requiredClaims: ["sub", "exp"],
      });
      if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(payload.sub)) return undefined;
      return {
        kind: "account",
        userId: `account:${payload.sub}`,
        ...(typeof payload.name === "string" ? { name: normalizeDisplayName(payload.name) } : {}),
      };
    } catch {
      return undefined;
    }
  }
  /** A guest token's claims when this service signed it, expired or not. */
  private readGuest(token: string): { id: string; expiresAt: number } | undefined {
    if (token.length > 10_000 || !token.startsWith("guest.")) return undefined;
    const [, payload, signature, extra] = token.split(".");
    try {
      if (!payload || !signature || extra !== undefined) return undefined;
      const actual = Buffer.from(signature, "base64url");
      const expected = this.sign(payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { id?: unknown; expiresAt?: unknown };
      return typeof claims.id === "string" && typeof claims.expiresAt === "number"
        ? { id: claims.id, expiresAt: claims.expiresAt }
        : undefined;
    } catch {
      return undefined;
    }
  }
  private sign(value: string): Buffer {
    return createHmac("sha256", this.options.guestSecret)
      .update(value)
      .digest();
  }
}
