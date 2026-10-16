import type {
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import type { NativeToolResult, NativeTurnSink } from "./native-session.js";
import { judgeApproval, type AgentPolicyContext } from "./policy.js";
import type { ToolBridge } from "./tool-bridge.js";

/** What every protocol adapter is given to run one conversation. */
export interface DriverContext {
  binaryPath: string;
  workspacePath: string;
  env: Record<string, string>;
  /** A folder of the daemon's for this session's generated files, outside the workspace and removed with the session. */
  privateDirectory: string;
  processDirectory?: string;
  isolateUserConfig: boolean;
  /** OhMyGame's instructions for the project, added to the agent's own. */
  instructions: string;
  bridge: ToolBridge;
  policy: AgentPolicyContext;
  /** Folders that each hold a SKILL.md: plugin Skills and OhMyGame's own. */
  skillDirectories: readonly string[];
  /**
   * A loopback MCP endpoint for agents that can only reach tools over HTTP. Its
   * token belongs to one turn, is revoked when that turn ends, and answers
   * only while `active` says this turn is running.
   */
  httpBridge?: (
    handlers: HttpBridgeHandlers,
  ) => Promise<{ url: string; token: string; revoke: () => void }>;
  model: string;
  reasoningLevel?: string;
  contextWindow?: number;
  /** The native session to continue, if the conversation has one. */
  resume?: string;
}

export interface HttpBridgeHandlers {
  signal: AbortSignal;
  active(): boolean;
  observe(
    call: { name: string; args: unknown; callId: string },
    outcome: { result: NativeToolResult; isError: boolean },
  ): void;
}

/**
 * Asks OhMyGame's policy, then the person when the policy leaves it to them.
 * Allowed, the decision is final for this request; asked, the person's
 * answer is.
 */
export async function decideApproval(
  details: ApprovalRequestDetails,
  context: DriverContext,
  sink: NativeTurnSink,
  options?: { callId?: string; signal?: AbortSignal; escalation?: boolean },
): Promise<ApprovalDecision> {
  if (options?.signal?.aborted) return "deny";
  const verdict = judgeApproval(details, context.policy);
  // An agent asks to escalate only for what its own sandbox would stop, so the workspace rule cannot allow it.
  if (verdict === "allow" && !options?.escalation) return "allow";
  if (verdict === "deny") return "deny";
  return sink.requestApproval(details, options);
}

/** Stores what a bridged OhMyGame tool returned, so its record keeps the artifact and not just MCP's text. */
export class BridgeResults {
  #results = new Map<string, { result: NativeToolResult; isError: boolean }>();

  record(
    callId: string,
    outcome: { result: NativeToolResult; isError: boolean },
  ): void {
    this.#results.set(callId, outcome);
    if (this.#results.size > 200)
      this.#results.delete(this.#results.keys().next().value!);
  }

  take(
    callId: string,
  ): { result: NativeToolResult; isError: boolean } | undefined {
    const outcome = this.#results.get(callId);
    this.#results.delete(callId);
    return outcome;
  }
}

/** Text a CLI returned for a tool, as OhMyGame's tool result. */
export function textResult(value: unknown): NativeToolResult {
  if (typeof value === "string")
    return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) {
    const content: NativeToolResult["content"] = [];
    for (const part of value) {
      if (!part || typeof part !== "object") continue;
      const block = part as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string")
        content.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        const source = block.source as Record<string, unknown> | undefined;
        const data =
          typeof block.data === "string"
            ? block.data
            : typeof source?.data === "string"
              ? source.data
              : undefined;
        const mimeType =
          typeof block.mimeType === "string"
            ? block.mimeType
            : typeof source?.media_type === "string"
              ? source.media_type
              : undefined;
        if (data && mimeType) content.push({ type: "image", data, mimeType });
      }
    }
    return { content };
  }
  if (value === undefined || value === null) return { content: [] };
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Pi's names for the file and shell tools every agent has, so their cards look the same whoever ran them. */
export function piToolCall(
  name: string,
  args: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  const file =
    stringValue(args.file_path) ??
    stringValue(args.filePath) ??
    stringValue(args.path);
  switch (name.toLowerCase()) {
    case "bash":
    case "shell":
      return {
        name: "bash",
        args: {
          command: stringValue(args.command) ?? "",
          ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
          ...(stringValue(args.description)
            ? { description: args.description }
            : {}),
        },
      };
    case "read":
      return {
        name: "read",
        args: {
          ...(file ? { path: file } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      };
    case "write":
      return { name: "write", args: { ...(file ? { path: file } : {}) } };
    case "edit":
    case "multiedit":
    case "apply_patch":
    case "patch":
      return { name: "edit", args: { ...(file ? { path: file } : {}) } };
    case "glob":
    case "find":
      return {
        name: "find",
        args: {
          ...(stringValue(args.pattern) ? { pattern: args.pattern } : {}),
          ...(file ? { path: file } : {}),
        },
      };
    case "grep":
      return {
        name: "grep",
        args: {
          ...(stringValue(args.pattern) ? { pattern: args.pattern } : {}),
          ...(file ? { path: file } : {}),
        },
      };
    case "ls":
    case "list":
      return { name: "ls", args: { ...(file ? { path: file } : {}) } };
    default:
      return { name, args };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
