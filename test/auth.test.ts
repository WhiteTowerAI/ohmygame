import { describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";
import {
  authUser,
  createOAuthAuthorizationUrl,
  createSupabaseClient,
  exchangeDesktopCallback,
  getAccessToken,
  restoreAuthState,
  signOut,
  startOAuth,
} from "../src/renderer/auth.js";

describe("renderer auth", () => {
  it("uses provider profile metadata for the account", () => {
    expect(authUser(user({ full_name: "Di Huang", avatar_url: "https://example.com/avatar.png" }))).toEqual({
      id: "user-1",
      name: "Di Huang",
      email: "di@example.com",
      avatarUrl: "https://example.com/avatar.png",
    });
  });

  it("falls back to email when profile metadata is absent", () => {
    expect(authUser(user({}))).toMatchObject({ id: "user-1", name: "di@example.com" });
  });

  it("stays unconfigured unless both public Supabase values exist", () => {
    expect(createSupabaseClient("", "key")).toBeUndefined();
    expect(createSupabaseClient("https://example.supabase.co", "")).toBeUndefined();
  });

  it("restores a persisted session and falls back to signed out on failure", async () => {
    const signedIn = client({ getSession: vi.fn(async () => ({ data: { session: { user: user({ name: "Creator" }) } } })) });
    const unavailable = client({ getSession: vi.fn(async () => { throw new Error("offline"); }) });

    await expect(restoreAuthState(signedIn)).resolves.toMatchObject({ status: "signed-in", user: { name: "Creator" } });
    await expect(restoreAuthState(unavailable)).resolves.toEqual({ status: "signed-out" });
  });

  it("returns the current access token for an authenticated request", async () => {
    const authenticated = client({
      getSession: vi.fn(async () => ({ data: { session: { access_token: "user-token" } }, error: null })),
    });

    await expect(getAccessToken(authenticated)).resolves.toBe("user-token");
    const expired = new Error("Session expired");
    await expect(getAccessToken(client({
      getSession: vi.fn(async () => ({ data: { session: null }, error: expired })),
    }))).rejects.toBe(expired);
  });

  it.each(["google", "github"] as const)("starts the %s OAuth provider with the requested redirect", async (provider) => {
    const signInWithOAuth = vi.fn(async () => ({ data: { provider, url: "https://example.com" }, error: null }));

    await startOAuth(client({ signInWithOAuth }), provider, "http://127.0.0.1:43120/#/projects/project");

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider,
      options: { redirectTo: "http://127.0.0.1:43120/#/projects/project" },
    });
  });

  it.each(["google", "github"] as const)("returns a desktop %s OAuth URL without navigating the renderer", async (provider) => {
    const signInWithOAuth = vi.fn(async () => ({ data: { provider, url: "https://auth.example/authorize" }, error: null }));

    await expect(createOAuthAuthorizationUrl(client({ signInWithOAuth }), provider, "http://127.0.0.1:45678/auth/callback/nonce"))
      .resolves.toBe("https://auth.example/authorize");
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider,
      options: { redirectTo: "http://127.0.0.1:45678/auth/callback/nonce", skipBrowserRedirect: true },
    });
  });

  it("exchanges a validated desktop callback code", async () => {
    const exchangeCodeForSession = vi.fn(async () => ({ data: {}, error: null }));

    await exchangeDesktopCallback(client({ exchangeCodeForSession }), "http://127.0.0.1:45678/auth/callback/nonce?code=auth-code");

    expect(exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
    await expect(exchangeDesktopCallback(client({ exchangeCodeForSession }), "https://evil.example/?code=auth-code"))
      .rejects.toThrow("Invalid OAuth callback");
  });

  it("surfaces provider errors from the desktop callback", async () => {
    await expect(exchangeDesktopCallback(client({}), "http://127.0.0.1:45678/auth/callback/nonce?error_description=Access+denied"))
      .rejects.toThrow("Access denied");
  });

  it("surfaces OAuth and sign-out failures", async () => {
    const oauthError = new Error("OAuth failed");
    const signOutError = new Error("Sign out failed");

    await expect(startOAuth(client({ signInWithOAuth: vi.fn(async () => ({ data: {}, error: oauthError })) }), "github", "http://localhost/")).rejects.toBe(oauthError);
    await expect(signOut(client({ signOut: vi.fn(async () => ({ error: signOutError })) }))).rejects.toBe(signOutError);
  });
});

function client(overrides: Record<string, unknown>) {
  return {
    auth: {
      exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null })),
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      ...overrides,
    },
  } as unknown as Parameters<typeof restoreAuthState>[0];
}

function user(user_metadata: Record<string, unknown>): User {
  return {
    id: "user-1",
    app_metadata: {},
    user_metadata,
    aud: "authenticated",
    created_at: "2026-01-01T00:00:00.000Z",
    email: "di@example.com",
  } as User;
}
