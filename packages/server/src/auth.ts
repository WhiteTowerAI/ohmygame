import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { gameTokenAudience } from "@ohmygame/sdk/account-protocol";
import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";

export interface MultiplayerIdentity {
  userId: string;
  kind: "account" | "guest";
}
export interface MultiplayerAuthOptions {
  guestSecret: string;
  /**
   * The OhMyGame account service that signs game tokens, such as https://api.ohmygame.ai.
   * Without it the service accepts guests only. See docs/game-sign-in.md.
   */
  accountIssuer?: string;
  /** Signing keys for tests; defaults to the issuer's /v1/game-auth/jwks.json. */
  accountKeys?: JWTVerifyGetKey;
}

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
  issueGuest(): { token: string; expiresAt: number } {
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    const payload = Buffer.from(
      JSON.stringify({ id: randomUUID(), expiresAt }),
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
      const [, payload, signature, extra] = token.split(".");
      try {
        if (!payload || !signature || extra) throw new Error();
        const actual = Buffer.from(signature, "base64url");
        const expected = this.sign(payload);
        if (
          actual.length !== expected.length ||
          !timingSafeEqual(actual, expected)
        )
          throw new Error();
        const claims = JSON.parse(
          Buffer.from(payload, "base64url").toString(),
        ) as { id?: unknown; expiresAt?: unknown };
        if (
          typeof claims.id !== "string" ||
          typeof claims.expiresAt !== "number" ||
          claims.expiresAt <= Date.now()
        )
          throw new Error();
        return { kind: "guest", userId: `guest:${claims.id}` };
      } catch {
        throw new Error("The guest token is invalid or expired.");
      }
    }
    if (policy === "anonymous")
      throw new Error("This game only accepts guests.");
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
      return { kind: "account", userId: `account:${payload.sub}` };
    } catch {
      throw new Error("The account token is invalid, expired or for another game.");
    }
  }
  private sign(value: string): Buffer {
    return createHmac("sha256", this.options.guestSecret)
      .update(value)
      .digest();
  }
}
