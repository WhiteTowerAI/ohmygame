import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import type { NativeToolResult } from "./native-session.js";

/** The MCP server name the agents know OhMyGame's tools under. */
export const BRIDGE_SERVER_NAME = "ohmygame";

/** Pi's own file and shell tools: every coding agent brings its own, so these are never offered. */
const AGENT_OWN_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "recall_image",
]);

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * OhMyGame's tools for a coding agent: canvas, media generation, game
 * checks, playtesting, questions and the plugin MCP servers (through the
 * same `mcp` tool Pi uses, so plugin credentials stay in the daemon). The
 * handlers are the ones Pi runs; this only answers MCP and runs them.
 */
export class ToolBridge {
  #tools: Map<string, ToolDefinition>;
  #active?: Set<string>;

  constructor(tools: readonly ToolDefinition[]) {
    this.#tools = new Map(
      tools
        .filter((tool) => !AGENT_OWN_TOOLS.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
  }

  get names(): string[] {
    return [...this.#tools.keys()];
  }

  /** Limits the tools to those OhMyGame's mode allows, such as planning's read-only set. */
  setActive(names: readonly string[]): void {
    this.#active = new Set(names);
  }

  list(): BridgeTool[] {
    return [...this.#tools.values()]
      .filter((tool) => !this.#active || this.#active.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters),
      }));
  }

  async call(
    name: string,
    args: unknown,
    callId: string,
    signal?: AbortSignal,
  ): Promise<{ result: NativeToolResult; isError: boolean }> {
    if (signal?.aborted) return failure("The turn was cancelled");
    const tool = this.#tools.get(name);
    if (!tool || (this.#active && !this.#active.has(name)))
      return failure(`Tool ${name} is not available`);
    const input =
      args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (!Check(tool.parameters, input)) {
      const problems = [...Errors(tool.parameters, input)]
        .slice(0, 5)
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      return failure(`Invalid arguments for ${name}: ${problems}`);
    }
    try {
      const output = await tool.execute(
        callId,
        input as never,
        signal ?? new AbortController().signal,
        undefined,
        undefined as never,
      );
      return {
        result: {
          content: output.content as NativeToolResult["content"],
          ...(output.details !== undefined ? { details: output.details } : {}),
        },
        isError: false,
      };
    } catch (cause) {
      return failure(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /**
   * Answers one MCP JSON-RPC message. A notification gets no answer. Each
   * tool call reports through `observe`, which records it in the conversation
   * with the result the tool returned rather than the text MCP carries back.
   */
  async handle(
    message: unknown,
    observe?: (
      call: { name: string; args: unknown; callId: string },
      outcome: { result: NativeToolResult; isError: boolean },
    ) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const request =
      message && typeof message === "object"
        ? (message as { id?: unknown; method?: unknown; params?: unknown })
        : {};
    if (request.id === undefined || request.id === null) return undefined;
    const id = request.id;
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: BRIDGE_SERVER_NAME, version: "1" },
            instructions:
              "OhMyGame's tools for this game project: canvas checks, image, video, 3D and audio generation, game playtesting and plugin services. Use them instead of writing your own replacements.",
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: this.list() } };
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const meta =
          params._meta && typeof params._meta === "object"
            ? (params._meta as Record<string, unknown>)
            : {};
        const callId =
          typeof meta["claudecode/toolUseId"] === "string"
            ? meta["claudecode/toolUseId"]
            : `${name}:${String(id)}`;
        const outcome = await this.call(name, params.arguments, callId, signal);
        observe?.({ name, args: params.arguments, callId }, outcome);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: outcome.result.content,
            ...(outcome.isError ? { isError: true } : {}),
          },
        };
      }
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${String(request.method)}`,
          },
        };
    }
  }
}

function failure(text: string): { result: NativeToolResult; isError: boolean } {
  return { result: { content: [{ type: "text", text }] }, isError: true };
}

/** TypeBox schemas are JSON Schema already; this drops the symbols TypeBox keeps on them. */
function jsonSchema(schema: unknown): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(schema ?? {})) as Record<
    string,
    unknown
  >;
  return value.type ? value : { type: "object", properties: {}, ...value };
}
