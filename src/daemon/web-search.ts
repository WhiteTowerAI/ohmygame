import { createHash } from "node:crypto";
import type {
  WebSearchExecution,
  WebSearchInput,
} from "../shared/web-search.js";
import type {
  StoredWebSearchSettings,
  WebSearchSettingsStore,
} from "./web-search-settings.js";

const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";
const PARALLEL_ENDPOINT = "https://search.parallel.ai/mcp";
const REQUEST_TIMEOUT_MS = 25_000;

type ConcreteProvider = WebSearchExecution["provider"];

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class WebSearchService {
  constructor(
    private readonly settings: WebSearchSettingsStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  enabled(): boolean {
    return this.settings.runtime().enabled;
  }

  async search(
    sessionId: string,
    input: WebSearchInput,
    signal?: AbortSignal,
  ): Promise<WebSearchExecution> {
    const settings = this.settings.runtime();
    if (!settings.enabled)
      throw new Error("Web search is disabled in Settings");
    const primary = selectProvider(settings, sessionId);
    try {
      return await this.#call(primary, settings, sessionId, input, signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const secondary = fallbackProvider(settings, primary);
      if (!settings.fallback || !secondary || !isRetryable(cause)) throw cause;
      const result = await this.#call(
        secondary,
        settings,
        sessionId,
        input,
        signal,
      );
      return { ...result, fallbackFrom: primary };
    }
  }

  async #call(
    provider: ConcreteProvider,
    settings: StoredWebSearchSettings,
    sessionId: string,
    input: WebSearchInput,
    signal?: AbortSignal,
  ): Promise<WebSearchExecution> {
    const definition = providerDefinition(provider, settings, sessionId, input);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.request(definition.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...definition.headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: definition.toolName,
            arguments: definition.arguments,
          },
        }),
        signal: combined,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const message = timeout.aborted
        ? `${definition.name} search timed out`
        : `${definition.name} search failed`;
      throw new WebSearchError(message, true);
    }
    if (!response.ok) {
      const publicAuthFailure =
        (response.status === 401 || response.status === 403) &&
        !definition.hasApiKey;
      throw new WebSearchError(
        `${definition.name} search returned HTTP ${response.status}`,
        response.status === 429 || response.status >= 500 || publicAuthFailure,
        response.status,
      );
    }
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new WebSearchError(`${definition.name} search response could not be read`, true);
    }
    const content = parseMcpSearchResponse(body);
    if (!content)
      throw new WebSearchError(
        `${definition.name} search returned no content`,
        false,
      );
    return { content, provider, providerName: definition.name };
  }
}

export function selectProvider(
  settings: StoredWebSearchSettings,
  sessionId: string,
): ConcreteProvider {
  if (settings.provider !== "auto") return settings.provider;
  const bucket = createHash("sha256").update(sessionId).digest()[0] ?? 0;
  return bucket % 2 === 0 ? "exa" : "parallel";
}

function fallbackProvider(
  settings: StoredWebSearchSettings,
  primary: ConcreteProvider,
): ConcreteProvider | undefined {
  if (settings.provider !== "auto") return undefined;
  return primary === "exa"
    ? "parallel"
    : primary === "parallel"
      ? "exa"
      : undefined;
}

function providerDefinition(
  provider: ConcreteProvider,
  settings: StoredWebSearchSettings,
  sessionId: string,
  input: WebSearchInput,
): {
  endpoint: string;
  toolName: string;
  name: string;
  headers?: Record<string, string>;
  arguments: Record<string, unknown>;
  hasApiKey: boolean;
} {
  if (provider === "exa") {
    const endpoint = new URL(EXA_ENDPOINT);
    if (settings.exaApiKey)
      endpoint.searchParams.set("exaApiKey", settings.exaApiKey);
    return {
      endpoint: endpoint.toString(),
      toolName: "web_search_exa",
      name: "Exa",
      hasApiKey: Boolean(settings.exaApiKey),
      arguments: {
        query: input.query,
        type: input.type ?? "auto",
        numResults: input.numResults ?? 8,
        livecrawl: input.livecrawl ?? "fallback",
        ...(input.contextMaxCharacters
          ? { contextMaxCharacters: input.contextMaxCharacters }
          : {}),
      },
    };
  }
  if (provider === "parallel") {
    return {
      endpoint: PARALLEL_ENDPOINT,
      toolName: "web_search",
      name: "Parallel",
      hasApiKey: Boolean(settings.parallelApiKey),
      ...(settings.parallelApiKey
        ? { headers: { Authorization: `Bearer ${settings.parallelApiKey}` } }
        : {}),
      arguments: {
        objective: input.query,
        search_queries: [input.query],
        session_id: createHash("sha256")
          .update(sessionId)
          .digest("hex")
          .slice(0, 32),
      },
    };
  }
  const custom = settings.custom;
  if (!custom) throw new Error("Custom web search provider is not configured");
  return {
    endpoint: custom.endpoint,
    toolName: custom.toolName,
    name: custom.name,
    hasApiKey: Boolean(custom.apiKey),
    ...(custom.apiKey
      ? { headers: { Authorization: `Bearer ${custom.apiKey}` } }
      : {}),
    arguments: { query: input.query, numResults: input.numResults ?? 8 },
  };
}

export function parseMcpSearchResponse(body: string): string | undefined {
  const direct = parseMcpPayload(body.trim());
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const content = parseMcpPayload(line.slice(5).trim());
    if (content) return content;
  }
  return undefined;
}

function parseMcpPayload(payload: string): string | undefined {
  if (!payload.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (isRecord(value.error))
    throw new WebSearchError(
      String(value.error.message ?? "MCP search failed"),
      false,
    );
  if (!isRecord(value.result)) return undefined;
  if (value.result.isError === true) {
    const message = contentText(value.result.content) ?? "MCP search failed";
    throw new WebSearchError(message, false);
  }
  return contentText(value.result.content);
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const texts = value.flatMap((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string"
      ? [item.text]
      : [],
  );
  return texts.length ? texts.join("\n\n") : undefined;
}

function isRetryable(cause: unknown): boolean {
  return cause instanceof WebSearchError && cause.retryable;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
