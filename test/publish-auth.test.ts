import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createSupabaseTokenVerifier } from "../src/publish-server/auth.js";

describe("publish authentication", () => {
  it("accepts only current tokens signed by the configured Supabase project", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const { privateKey: forgedPrivateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const issuer = "https://project.supabase.co/auth/v1";
    const verifier = createSupabaseTokenVerifier(
      "https://project.supabase.co",
      createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "ES256", use: "sig" }] }),
    );
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    await expect(verifier(token)).resolves.toBe("user-123");

    const wrongAudience = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("anonymous")
      .setSubject("user-123")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifier(wrongAudience)).resolves.toBeUndefined();

    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject("user-123")
      .setExpirationTime(Math.floor(Date.now() / 1_000) - 60)
      .sign(privateKey);
    await expect(verifier(expired)).resolves.toBeUndefined();

    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject("user-123")
      .setExpirationTime("5m")
      .sign(forgedPrivateKey);
    await expect(verifier(forged)).resolves.toBeUndefined();
  });
});
