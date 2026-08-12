import { timingSafeEqual } from "node:crypto";

export function matchesBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return false;
  const actual = Buffer.from(token);
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
