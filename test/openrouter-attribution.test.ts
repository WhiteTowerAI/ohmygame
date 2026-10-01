import { describe, expect, it } from "vitest";
import { isOpenRouterModel, openRouterAttributionExtension, withOpenRouterAttribution } from "../src/daemon/openrouter-attribution.js";

const OHMYGAME = {
  "HTTP-Referer": "https://ohmygame.ai/",
  "X-OpenRouter-Title": "OhMyGame",
  "X-OpenRouter-Categories": "game,native-app-builder",
};

describe("OpenRouter attribution", () => {
  it("adds OhMyGame attribution headers", () => {
    expect(withOpenRouterAttribution({ authorization: "Bearer sk-or" })).toEqual({ authorization: "Bearer sk-or", ...OHMYGAME });
  });

  it("replaces Pi's default attribution", () => {
    expect(withOpenRouterAttribution({
      "HTTP-Referer": "https://pi.dev",
      "X-OpenRouter-Title": "pi",
      "X-OpenRouter-Categories": "cli-agent",
    })).toEqual(OHMYGAME);
  });

  it("keeps headers the user configured", () => {
    expect(withOpenRouterAttribution({ "http-referer": "https://example.com", "x-openrouter-title": "Mine" })).toEqual({
      "http-referer": "https://example.com",
      "x-openrouter-title": "Mine",
      "X-OpenRouter-Categories": "game,native-app-builder",
    });
  });

  it("detects OpenRouter models by provider or host", () => {
    expect(isOpenRouterModel({ provider: "openrouter" })).toBe(true);
    expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
    expect(isOpenRouterModel({ provider: "anthropic", baseUrl: "https://api.anthropic.com" })).toBe(false);
    expect(isOpenRouterModel(undefined)).toBe(false);
  });

  it("rewrites agent-session headers only for OpenRouter models", async () => {
    let handler: ((event: { headers: Record<string, string | null> }, ctx: { model?: unknown }) => unknown) | undefined;
    openRouterAttributionExtension({ on: (_event: string, fn: typeof handler) => { handler = fn; } } as never);

    const openRouter = { headers: { "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "pi" } as Record<string, string | null> };
    await handler?.(openRouter, { model: { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } });
    expect(openRouter.headers).toEqual(OHMYGAME);

    const other = { headers: { "x-api-key": "k" } as Record<string, string | null> };
    await handler?.(other, { model: { provider: "anthropic", baseUrl: "https://api.anthropic.com" } });
    expect(other.headers).toEqual({ "x-api-key": "k" });
  });
});
