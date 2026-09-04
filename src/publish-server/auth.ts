import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sendPublishError } from "./http.js";

export interface VerifiedPublisher {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

export type PublisherTokenVerifier = (token: string) => Promise<string | VerifiedPublisher | undefined>;

export function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  return match?.[1];
}

export async function requirePublisher(
  request: FastifyRequest,
  reply: FastifyReply,
  verifyToken: PublisherTokenVerifier,
  ensurePublisher: (publisher: VerifiedPublisher, createdAt: string) => void,
): Promise<string | undefined> {
  const token = bearerToken(request.headers.authorization);
  const verified = token ? await verifyToken(token) : undefined;
  if (!verified) {
    sendPublishError(reply, request, 401, "authentication_required", "Authentication required");
    return undefined;
  }
  const publisher = typeof verified === "string"
    ? { id: verified, displayName: "OpenGame Creator" }
    : verified;
  ensurePublisher(publisher, new Date().toISOString());
  return publisher.id;
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
      if (typeof payload.sub !== "string" || !payload.sub) return undefined;
      const metadata = payload.user_metadata && typeof payload.user_metadata === "object"
        ? payload.user_metadata as Record<string, unknown>
        : {};
      const displayName = [metadata.full_name, metadata.name, metadata.user_name]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim()
        ?? "OpenGame Creator";
      const avatarUrl = [metadata.avatar_url, metadata.picture]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
      return { id: payload.sub, displayName, ...(avatarUrl ? { avatarUrl } : {}) };
    } catch {
      return undefined;
    }
  };
}
