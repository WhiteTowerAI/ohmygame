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
const CUSTOM_SCHEMA_TTL_MS = 5 * 60_000;

type ConcreteProvider = WebSearchExecution["provider"];
type ProviderDefinition = ReturnType<typeof providerDefinition>;

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
  #customSchema?: {
    key: string;
    expiresAt: number;
    schema: Record<string, unknown>;
  };

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
    if (provider === "custom") {
      const schema = await this.#customToolSchema(
        definition,
        combined,
        timeout,
      );
      definition.arguments = customSearchArguments(schema, input);
    }
    const body = await this.#requestMcp(
      definition,
      "tools/call",
      {
        name: definition.toolName,
        arguments: definition.arguments,
      },
      combined,
      timeout,
    );
    const content = parseMcpSearchResponse(body);
    if (!content)
      throw new WebSearchError(
        `${definition.name} search returned no content`,
        false,
      );
    return { content, provider, providerName: definition.name };
  }

  async #customToolSchema(
    definition: ProviderDefinition,
    signal: AbortSignal,
    timeout: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const key = JSON.stringify([
      definition.endpoint,
      definition.toolName,
      definition.headers,
    ]);
    if (
      this.#customSchema?.key === key &&
      this.#customSchema.expiresAt > Date.now()
    )
      return this.#customSchema.schema;
    this.#customSchema = undefined;
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const body = await this.#requestMcp(
        definition,
        "tools/list",
        cursor ? { cursor } : {},
        signal,
        timeout,
      );
      const result = parseMcpResult(body);
      if (!result || !Array.isArray(result.tools))
        throw new WebSearchError(
          `${definition.name} returned an invalid MCP tool list`,
          false,
        );
      const tool = result.tools.find(
        (tool) => isRecord(tool) && tool.name === definition.toolName,
      );
      if (isRecord(tool)) {
        if (!isRecord(tool.inputSchema))
          throw new WebSearchError(
            `Custom MCP tool ${definition.toolName} has no input schema`,
            false,
          );
        this.#customSchema = {
          key,
          schema: tool.inputSchema,
          expiresAt: Date.now() + CUSTOM_SCHEMA_TTL_MS,
        };
        return tool.inputSchema;
      }
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor
          ? result.nextCursor
          : undefined;
      if (cursor && cursors.has(cursor))
        throw new WebSearchError(
          `${definition.name} returned a repeated MCP tool list cursor`,
          false,
        );
      if (cursor) cursors.add(cursor);
    } while (cursor);
    throw new WebSearchError(
      `Custom MCP tool ${definition.toolName} was not found`,
      false,
    );
  }

  async #requestMcp(
    definition: ProviderDefinition,
    method: "tools/list" | "tools/call",
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeout: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
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
          method,
          params,
        }),
        signal,
      });
    } catch (cause) {
      if (signal.aborted && !timeout.aborted) throw cause;
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
    try {
      return await response.text();
    } catch {
      if (signal.aborted && !timeout.aborted) signal.throwIfAborted();
      if (timeout.aborted)
        throw new WebSearchError(`${definition.name} search timed out`, true);
      throw new WebSearchError(
        `${definition.name} search response could not be read`,
        true,
      );
    }
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
    arguments: {},
  };
}

function customSearchArguments(
  schema: Record<string, unknown>,
  input: WebSearchInput,
): Record<string, unknown> {
  const properties = schema.properties;
  if (
    !isRecord(properties) ||
    !isRecord(properties.query) ||
    (properties.query.type !== undefined && properties.query.type !== "string")
  )
    throw new WebSearchError(
      "Custom MCP search tool must declare a string query parameter",
      false,
    );
  const args: Record<string, unknown> = { query: input.query };
  for (const name of ["numResults", "max_results"]) {
    const property = properties[name];
    if (
      !isRecord(property) ||
      (property.type !== "integer" && property.type !== "number")
    )
      continue;
    let count = input.numResults ?? 8;
    if (typeof property.minimum === "number")
      count = Math.max(count, Math.ceil(property.minimum));
    if (typeof property.maximum === "number")
      count = Math.min(count, Math.floor(property.maximum));
    args[name] = count;
    break;
  }
  const missing = Array.isArray(schema.required)
    ? schema.required.filter(
        (name) => typeof name === "string" && !Object.hasOwn(args, name),
      )
    : [];
  if (missing.length)
    throw new WebSearchError(
      `Custom MCP search tool requires unsupported parameters: ${missing.join(", ")}`,
      false,
    );
  return args;
}

export function parseMcpSearchResponse(body: string): string | undefined {
  const result = parseMcpResult(body);
  return result ? contentText(result.content) : undefined;
}

/** Join SSE data fields within each event before decoding its MCP payload. */
function parseMcpResult(body: string): Record<string, unknown> | undefined {
  const direct = parseMcpPayload(body.trim());
  if (direct) return direct;
  const events = body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n\n");
  for (const event of events) {
    const payload = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const content = parseMcpPayload(payload.trim());
    if (content) return content;
  }
  return undefined;
}

function parseMcpPayload(payload: string): Record<string, unknown> | undefined {
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
  return value.result;
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
