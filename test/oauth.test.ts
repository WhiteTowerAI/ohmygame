import { describe, expect, it, vi } from "vitest";
import { isOAuthAuthorizationUrl, OAuthCallbackFlow, startOAuthCallbackServer } from "../src/desktop/oauth.js";

describe("desktop OAuth", () => {
  it("receives the callback on a temporary loopback server", async () => {
    const onCallback = vi.fn();
    const server = await startOAuthCallbackServer(onCallback);

    const response = await fetch(`${server.url}?code=auth-code`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign-in complete");
    expect(onCallback).toHaveBeenCalledWith(`${server.url}?code=auth-code`);
    await server.close();
  });

  it("rejects paths outside the callback route", async () => {
    const onCallback = vi.fn();
    const server = await startOAuthCallbackServer(onCallback);
    const origin = new URL(server.url).origin;

    expect((await fetch(`${origin}/other?code=auth-code`)).status).toBe(404);
    expect(onCallback).not.toHaveBeenCalled();
    await server.close();
  });

  it("uses one callback server for concurrent requests", async () => {
    const flow = new OAuthCallbackFlow(vi.fn());

    const [first, second] = await Promise.all([flow.callbackUrl(), flow.callbackUrl()]);

    expect(first).toBe(second);
    await flow.cancel();
  });

  it("discards a pending callback when the flow is cancelled", async () => {
    const notify = vi.fn();
    const flow = new OAuthCallbackFlow(notify);
    const callbackUrl = await flow.callbackUrl();

    expect((await fetch(`${callbackUrl}?code=auth-code`)).status).toBe(200);
    expect(notify).toHaveBeenCalledOnce();
    await flow.cancel();

    expect(flow.takeCallback()).toBeUndefined();
  });

  it("opens only HTTPS authorization URLs", () => {
    expect(isOAuthAuthorizationUrl("https://project.supabase.co/auth/v1/authorize")).toBe(true);
    expect(isOAuthAuthorizationUrl("http://project.supabase.co/auth/v1/authorize")).toBe(false);
    expect(isOAuthAuthorizationUrl("file:///tmp/private")).toBe(false);
  });
});
