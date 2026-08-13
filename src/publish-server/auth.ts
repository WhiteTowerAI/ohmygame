import { createHash } from "node:crypto";

export function hashPublisherToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
  return match?.[1];
}
