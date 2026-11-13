import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ApprovalRequestDetails } from "../shared/agent-runtimes.js";
import {
  TOOL_HOOK_TEXT_MAX_CHARS,
  type ToolHookInput,
  type ToolHookResult,
} from "../shared/plugin-hooks.js";

/** Shared boundary for Pi, coding-agent bridges and individual MCP calls. */
export interface HostedToolHooks {
  before(call: ToolHookInput, signal?: AbortSignal): Promise<void>;
  after(result: ToolHookResult): Promise<void>;
}

export function pluginToolApprovalRequest(
  plugin: string,
  call: ToolHookInput,
  reason: string,
): ApprovalRequestDetails {
  const input = JSON.stringify(call.args, null, 2);
  if (input.length > TOOL_HOOK_TEXT_MAX_CHARS)
    throw new Error(
      "Tool arguments are too large to review for approval; split the operation into smaller calls",
    );
  const tool = call.server ? `${call.server}/${call.tool}` : call.tool;
  return { kind: "tool", tool, title: `${plugin}: ${tool}`, reason, input };
}

export function toolHookResult(
  call: ToolHookInput,
  failed: boolean,
  content: unknown,
): ToolHookResult {
  let text = "";
  let truncated = false;
  for (const item of Array.isArray(content) ? content : []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    const addition = `${text ? "\n" : ""}${item.text}`;
    const remaining = TOOL_HOOK_TEXT_MAX_CHARS - text.length;
    text += addition.slice(0, remaining);
    if (addition.length > remaining) truncated = true;
  }
  return {
    ...call,
    status: failed ? "failed" : "succeeded",
    text,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Notices run independently and cannot replace the outcome or fail a successful call. */
export function notifyToolResult(
  hooks: HostedToolHooks | undefined,
  result: ToolHookResult,
): void {
  if (hooks)
    void Promise.resolve()
      .then(() => hooks.after(structuredClone(result)))
      .catch(() => {});
}

/** Pi swallows extension errors, so a failed gate must explicitly block execution. */
export function toolHooksExtension(
  hooks: HostedToolHooks,
  signal: () => AbortSignal,
  mcpTools: ReadonlySet<string> = new Set(),
): ExtensionFactory {
  return (pi) => {
    const started = new Set<string>();
    pi.on("agent_end", () => {
      started.clear();
    });
    pi.on("session_shutdown", () => {
      started.clear();
    });
    pi.on("tool_call", async (event) => {
      if (mcpTools.has(event.toolName)) return;
      try {
        await hooks.before(
          {
            callId: event.toolCallId,
            tool: event.toolName,
            args: structuredClone(event.input),
            source: "agent",
          },
          signal(),
        );
        signal().throwIfAborted();
        started.add(event.toolCallId);
      } catch (cause) {
        return {
          block: true,
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    });
    pi.on("tool_result", (event) => {
      if (mcpTools.has(event.toolName) || !started.delete(event.toolCallId))
        return;
      notifyToolResult(
        hooks,
        toolHookResult(
          {
            callId: event.toolCallId,
            tool: event.toolName,
            args: structuredClone(event.input),
            source: "agent",
          },
          event.isError,
          event.content,
        ),
      );
    });
  };
}
