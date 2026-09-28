import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WebSearchService,
  parseMcpSearchResponse,
  selectProvider,
} from "../src/daemon/web-search.js";
import { WebSearchSettingsStore } from "../src/daemon/web-search-settings.js";

const resultBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "Search result" }] },
});

describe("web search", () => {
  it("assigns each session deterministically across both public providers", () => {
    const settings = {
      version: 1,
      enabled: true,
      provider: "auto",
      fallback: true,
    } as const;
    expect(selectProvider(settings, "same-session")).toBe(
      selectProvider(settings, "same-session"),
    );
    expect(
      new Set(
        Array.from({ length: 40 }, (_, index) =>
          selectProvider(settings, `session-${index}`),
        ),
      ),
    ).toEqual(new Set(["exa", "parallel"]));
  });

  it("falls back once when the assigned public provider is unavailable", async () => {
    const store = await settingsStore({ provider: "auto", fallback: true });
    const primary = selectProvider(store.runtime(), "fallback-session");
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const isPrimary =
        primary === "exa"
          ? url.includes("mcp.exa.ai")
          : url.includes("search.parallel.ai");
      return isPrimary
        ? new Response("unavailable", { status: 503 })
        : new Response(resultBody);
    });

    const result = await new WebSearchService(store, request).search(
      "fallback-session",
      { query: "latest Godot release" },
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.content).toBe("Search result");
    expect(result.fallbackFrom).toBe(primary);
    expect(result.provider).not.toBe(primary);
  });

  it("falls back when a successful response body is interrupted", async () => {
    const store = await settingsStore({ provider: "auto", fallback: true });
    const primary = selectProvider(store.runtime(), "body-failure-session");
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const isPrimary = primary === "exa" ? url.includes("mcp.exa.ai") : url.includes("search.parallel.ai");
      if (!isPrimary) return new Response(resultBody);
      return { ok: true, text: async () => { throw new Error("stream closed"); } } as unknown as Response;
    });

    const result = await new WebSearchService(store, request).search("body-failure-session", { query: "query" });

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.fallbackFrom).toBe(primary);
  });

  it("does not switch away from an explicitly selected provider", async () => {
    const store = await settingsStore({ provider: "exa", fallback: true });
    const request = vi.fn<typeof fetch>(
      async () => new Response("limited", { status: 429 }),
    );

    await expect(
      new WebSearchService(store, request).search("session", {
        query: "query",
      }),
    ).rejects.toThrow("HTTP 429");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses provider-specific authentication and a pseudonymous Parallel session id", async () => {
    const store = await settingsStore({
      provider: "parallel",
      fallback: false,
      parallelApiKey: "parallel-key",
    });
    const request = vi.fn<typeof fetch>(async () => new Response(resultBody));

    await new WebSearchService(store, request).search("local-conversation-id", {
      query: "query",
    });

    const [, init] = request.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer parallel-key",
    );
    const body = JSON.parse(String(init?.body)) as {
      params: { arguments: { session_id: string } };
    };
    expect(body.params.arguments.session_id).toMatch(/^[a-f0-9]{32}$/);
    expect(body.params.arguments.session_id).not.toContain(
      "local-conversation-id",
    );
  });

  it("parses JSON and event-stream MCP responses", () => {
    expect(parseMcpSearchResponse(resultBody)).toBe("Search result");
    expect(
      parseMcpSearchResponse(`event: message\ndata: ${resultBody}\n\n`),
    ).toBe("Search result");
  });
});

async function settingsStore(overrides: {
  provider: "auto" | "exa" | "parallel";
  fallback: boolean;
  parallelApiKey?: string;
}): Promise<WebSearchSettingsStore> {
  const store = new WebSearchSettingsStore(
    await mkdtemp(path.join(tmpdir(), "ohmygame-web-search-")),
  );
  await store.load();
  await store.update({
    enabled: true,
    provider: overrides.provider,
    fallback: overrides.fallback,
    ...(overrides.parallelApiKey
      ? { parallelApiKey: overrides.parallelApiKey }
      : {}),
  });
  return store;
}
