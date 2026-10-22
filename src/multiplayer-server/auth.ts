import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { MultiplayerAuthPolicy } from "../shared/multiplayer-protocol.js";

export interface MultiplayerIdentity {
  userId: string;
  kind: "account" | "guest";
}
export interface MultiplayerAuthOptions {
  guestSecret: string;
  supabaseUrl?: string;
  supabaseKey?: string;
}

export class MultiplayerAuth {
  constructor(private readonly options: MultiplayerAuthOptions) {
    if (Buffer.byteLength(options.guestSecret) < 32)
      throw new Error(
        "MULTIPLAYER_GUEST_SECRET must contain at least 32 bytes.",
      );
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
  async authenticate(
    token: string | undefined,
    policy: MultiplayerAuthPolicy,
  ): Promise<MultiplayerIdentity> {
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
    const { supabaseUrl, supabaseKey } = this.options;
    if (!supabaseUrl || !supabaseKey)
      throw new Error(
        "Supabase Auth is not configured on the multiplayer service.",
      );
    // Supabase verifies signature, issuer, expiration and revocation for this project.
    const response = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`,
      {
        headers: { apikey: supabaseKey, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok)
      throw new Error("The account token is invalid or expired.");
    const user = (await response.json()) as {
      id?: unknown;
      is_anonymous?: unknown;
    };
    if (
      typeof user.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(user.id) ||
      user.is_anonymous
    )
      throw new Error("A registered Supabase account is required.");
    return { kind: "account", userId: `account:${user.id}` };
  }
  private sign(value: string): Buffer {
    return createHmac("sha256", this.options.guestSecret)
      .update(value)
      .digest();
  }
}
