import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateWebSearchSettings } from "../src/shared/web-search.js";
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

afterEach(() => vi.restoreAllMocks());

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

  it("omits undeclared arguments for strict query-only custom tools", async () => {
    const store = await settingsStore(customSettings);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list")
        return toolList({ query: { type: "string" } });
      if (Object.keys(body.params.arguments).some((key) => key !== "query"))
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: "Unknown parameter" },
          }),
        );
      expect(body.params).toEqual({
        name: "search",
        arguments: { query: "Godot docs" },
      });
      return new Response(resultBody);
    });
    const service = new WebSearchService(store, request);

    await expect(
      service.search("session", { query: "Godot docs", numResults: 4 }),
    ).resolves.toMatchObject({ provider: "custom", content: "Search result" });
    await service.search("session", { query: "Godot docs" });
    expect(
      request.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).method,
      ),
    ).toEqual(["tools/list", "tools/call", "tools/call"]);
  });

  it.each([
    ["numResults", undefined, 8, {}],
    ["numResults", 4, 4, {}],
    ["max_results", 4, 4, {}],
    ["max_results", 20, 5, { maximum: 5 }],
    ["max_results", 1, 3, { minimum: 3 }],
  ])(
    "uses declared %s with count %s",
    async (name, requested, expected, bounds) => {
      const store = await settingsStore(customSettings);
      const request = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.method === "tools/list")
          return toolList({
            query: { type: "string" },
            [name]: { type: "integer", ...bounds },
          });
        expect(body.params.arguments).toEqual({
          query: "query",
          [name]: expected,
        });
        return new Response(resultBody);
      });
      await new WebSearchService(store, request).search("session", {
        query: "query",
        numResults: requested,
      });
    },
  );

  it("discovers paginated tools in SSE and authenticates both requests", async () => {
    const store = await settingsStore({
      ...customSettings,
      custom: { ...customSettings.custom, apiKey: "custom-secret" },
    });
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(customSettings.custom.endpoint);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer custom-secret",
      );
      expect(init?.signal?.aborted).toBe(false);
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list") {
        if (!body.params.cursor)
          return new Response(
            JSON.stringify({
              result: { tools: [{ name: "other" }], nextCursor: "page-2" },
            }),
          );
        expect(body.params.cursor).toBe("page-2");
        return new Response(
          `event: message\ndata: ${await toolList({ query: { type: "string" } }).text()}\n\n`,
        );
      }
      return new Response(`event: message\ndata: ${resultBody}\n\n`);
    });
    await expect(
      new WebSearchService(store, request).search(
        "session",
        { query: "query" },
        controller.signal,
      ),
    ).resolves.toMatchObject({ content: "Search result" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(
      new Set(request.mock.calls.map(([, init]) => init?.signal)).size,
    ).toBe(1);
  });

  it.each(["\n", "\r\n", "\r"])(
    "uses multiline SSE for custom discovery and search with %j line endings",
    async (newline) => {
      const store = await settingsStore(customSettings);
      const request = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const payload =
          body.method === "tools/list"
            ? await toolList({
                query: { type: "string" },
                max_results: { type: "integer", maximum: 5 },
              }).text()
            : resultBody;
        if (body.method === "tools/call")
          expect(body.params.arguments).toEqual({
            query: "game engine docs",
            max_results: 5,
          });
        return new Response(`\uFEFF${searchEvent(payload, newline)}`, {
          headers: { "content-type": "text/event-stream" },
        });
      });

      await expect(
        new WebSearchService(store, request).search("session", {
          query: "game engine docs",
          numResults: 8,
        }),
      ).resolves.toMatchObject({ provider: "custom", content: "Search result" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    [{ tools: [] }, "was not found"],
    [{ tools: [{ name: "search" }] }, "has no input schema"],
    [
      {
        tools: [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: { objective: { type: "string" } },
            },
          },
        ],
      },
      "must declare a string query",
    ],
    [
      {
        tools: [
          {
            name: "search",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                region: { type: "string" },
              },
              required: ["query", "region"],
            },
          },
        ],
      },
      "requires unsupported parameters: region",
    ],
    [{ content: [] }, "invalid MCP tool list"],
  ])(
    "rejects incompatible discovery results without calling or falling back: %j",
    async (result, message) => {
      const store = await settingsStore(customSettings);
      const request = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify({ result })),
      );
      await expect(
        new WebSearchService(store, request).search("session", {
          query: "query",
        }),
      ).rejects.toThrow(message);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("does not loop on repeated discovery cursors", async () => {
    const store = await settingsStore(customSettings);
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ result: { tools: [], nextCursor: "same" } }),
        ),
    );
    await expect(
      new WebSearchService(store, request).search("session", {
        query: "query",
      }),
    ).rejects.toThrow("repeated MCP tool list cursor");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("refreshes discovery after expiry or custom connection changes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const store = await settingsStore(customSettings);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.method === "tools/list"
        ? toolList(
            { query: { type: "string" } },
            store.runtime().custom?.toolName,
          )
        : new Response(resultBody);
    });
    const service = new WebSearchService(store, request);
    await service.search("session", { query: "query" });
    now.mockReturnValue(1_000 + 5 * 60_000);
    await service.search("session", { query: "query" });
    for (const change of [
      { endpoint: "https://other.example/mcp" },
      { toolName: "other-search" },
      { apiKey: "new-key" },
    ]) {
      await store.update({
        enabled: true,
        ...customSettings,
        custom: { ...store.runtime().custom!, ...change },
      });
      await service.search("session", { query: "query" });
    }
    expect(
      request.mock.calls.filter(
        ([, init]) => JSON.parse(String(init?.body)).method === "tools/list",
      ),
    ).toHaveLength(5);
  });

  it("does not cache failed discovery or silently call with guessed arguments", async () => {
    const store = await settingsStore(customSettings);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: "Discovery failed" } }),
        ),
      )
      .mockResolvedValueOnce(toolList({ query: { type: "string" } }))
      .mockResolvedValueOnce(new Response(resultBody));
    const service = new WebSearchService(store, request);
    await expect(service.search("session", { query: "query" })).rejects.toThrow(
      "Discovery failed",
    );
    await expect(
      service.search("session", { query: "query" }),
    ).resolves.toMatchObject({ content: "Search result" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not search after cancellation during discovery", async () => {
    const store = await settingsStore(customSettings);
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async () => {
      controller.abort();
      return toolList({ query: { type: "string" } });
    });
    await expect(
      new WebSearchService(store, request).search(
        "session",
        { query: "query" },
        controller.signal,
      ),
    ).rejects.toThrow("abort");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps Exa arguments and skips schema discovery for public providers", async () => {
    const store = await settingsStore({ provider: "exa", fallback: false });
    const request = vi.fn<typeof fetch>(async () => new Response(resultBody));
    await new WebSearchService(store, request).search("session", {
      query: "query",
      numResults: 3,
      type: "deep",
      livecrawl: "preferred",
      contextMaxCharacters: 2000,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: "query",
          numResults: 3,
          type: "deep",
          livecrawl: "preferred",
          contextMaxCharacters: 2000,
        },
      },
    });
  });

  it("does not send a numeric count to a string parameter", async () => {
    const store = await settingsStore(customSettings);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list")
        return toolList({
          query: { type: "string" },
          numResults: { type: "string" },
        });
      expect(body.params.arguments).toEqual({ query: "query" });
      return new Response(resultBody);
    });
    await new WebSearchService(store, request).search("session", {
      query: "query",
    });
  });

  it("reports a discovery timeout without calling the search tool", async () => {
    const store = await settingsStore(customSettings);
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const request = vi.fn<typeof fetch>(async () => {
      timeout.abort();
      timeout.signal.throwIfAborted();
      throw new Error("unreachable");
    });
    await expect(
      new WebSearchService(store, request).search("session", {
        query: "query",
      }),
    ).rejects.toThrow("Custom search search timed out");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: { message: "Server rejected the request" } },
    {
      result: {
        isError: true,
        content: [{ type: "text", text: "Server rejected the request" }],
      },
    },
  ])("preserves MCP protocol and tool errors", (payload) => {
    for (const body of [
      JSON.stringify(payload),
      `data: ${JSON.stringify(payload)}\n\n`,
    ])
      expect(() => parseMcpSearchResponse(body)).toThrow(
        "Server rejected the request",
      );
  });

  it("uses a multiline event-stream response through the search service", async () => {
    const store = await settingsStore({ provider: "exa", fallback: false });
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(searchEvent(resultBody, "\r\n"), {
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const result = await new WebSearchService(store, request).search(
      "session",
      { query: "game engine docs" },
    );

    expect(result.content).toBe("Search result");
    expect(result.provider).toBe("exa");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["\n", "\r\n", "\r"])(
    "joins data lines within one event with %j line endings",
    (newline) => {
      const notification = `: keepalive${newline}data: {"jsonrpc":"2.0","method":"notifications/progress"}${newline}${newline}`;
      expect(
        parseMcpSearchResponse(notification + searchEvent(resultBody, newline)),
      ).toBe("Search result");
    },
  );

  it("accepts a leading BOM and preserves complete events without a final blank line", () => {
    expect(parseMcpSearchResponse(`\uFEFFdata: ${resultBody}\n\n`)).toBe(
      "Search result",
    );
    expect(parseMcpSearchResponse(searchEvent(resultBody).trimEnd())).toBe(
      "Search result",
    );
  });

  it("does not join data from separate events", () => {
    expect(
      parseMcpSearchResponse(
        'data: {"result":\n\ndata: {"content":[{"type":"text","text":"not one event"}]}}\n\n',
      ),
    ).toBeUndefined();
  });

  it("preserves multiline MCP errors", () => {
    const error = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32603, message: "Search unavailable" },
    });
    const toolError = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        content: [{ type: "text", text: "Tool failed" }],
      },
    });
    expect(() => parseMcpSearchResponse(searchEvent(error))).toThrow(
      "Search unavailable",
    );
    expect(() => parseMcpSearchResponse(searchEvent(toolError))).toThrow(
      "Tool failed",
    );
  });

  it("parses JSON and event-stream MCP responses", () => {
    expect(parseMcpSearchResponse(resultBody)).toBe("Search result");
    expect(
      parseMcpSearchResponse(`event: message\ndata: ${resultBody}\n\n`),
    ).toBe("Search result");
  });
});

function searchEvent(payload: string, newline = "\n"): string {
  return [
    "event: message",
    "id: search-1",
    ...JSON.stringify(JSON.parse(payload), null, 2)
      .split("\n")
      .map((line) => `data: ${line}`),
    "",
    "",
  ].join(newline);
}

const customSettings = {
  provider: "custom",
  fallback: true,
  custom: {
    name: "Custom search",
    endpoint: "https://search.example/mcp",
    toolName: "search",
  },
} as const;

function toolList(
  properties: Record<string, unknown>,
  name = "search",
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name,
            inputSchema: {
              type: "object",
              properties,
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      },
    }),
  );
}

async function settingsStore(
  overrides: Omit<UpdateWebSearchSettings, "enabled">,
): Promise<WebSearchSettingsStore> {
  const store = new WebSearchSettingsStore(
    await mkdtemp(path.join(tmpdir(), "ohmygame-web-search-")),
  );
  await store.load();
  await store.update({ enabled: true, ...overrides });
  return store;
}
