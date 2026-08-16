import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type PublisherTokenVerifier = (token: string) => Promise<string | undefined>;

export function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  return match?.[1];
}

export function createSupabaseTokenVerifier(
  configuredUrl: string,
  keySet?: JWTVerifyGetKey,
): PublisherTokenVerifier {
  const supabaseUrl = new URL(configuredUrl);
  const issuer = new URL("/auth/v1", supabaseUrl).href.replace(/\/$/, "");
  const keys = keySet ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, audience: "authenticated" });
      return typeof payload.sub === "string" && payload.sub ? payload.sub : undefined;
    } catch {
      return undefined;
    }
  };
}
