import { isAgentRuntimeId } from "../../shared/agent-runtimes.js";
import { AGENT_RUNTIME_DEFINITIONS } from "./definitions.js";

/** The `api` of assistant messages a coding agent's turn recorded in the shared session. */
export const NATIVE_API = "ohmygame-native";

const MAX_RESULT = 2_000;
const MAX_ARGUMENTS = 400;

interface ReplayMessage {
  role?: unknown;
  api?: unknown;
  provider?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
}

type Block = Record<string, unknown>;

/**
 * Prepares a conversation a coding agent worked in for OhMyGame's own agent.
 * A native turn is stored as Pi messages so Undo, branches and the timeline
 * work, but its tool calls use the CLI's tools: names Pi may not have (Skill,
 * Agent, task, web_search) and arguments that do not fit Pi's tools of the
 * same name (Codex's edit is a path, not a replacement). Replayed as calls,
 * they read to the next model as examples of how to call its own tools. Each
 * native turn is replayed as text instead: what the agent said, which tools
 * it used with what, and a bounded account of their results. Everything else
 * passes through unchanged.
 */
export function replayNativeMessages<Message>(
  messages: readonly Message[],
): Message[] {
  const nativeCalls = new Set<string>();
  const replayed: Message[] = [];
  let open: { message: ReplayMessage; lines: string[] } | undefined;
  const close = () => {
    if (!open) return;
    const text = open.lines.join("\n\n").trim();
    if (text)
      replayed.push({
        ...open.message,
        content: [{ type: "text", text }],
      } as Message);
    open = undefined;
  };
  for (const message of messages) {
    const record = message as ReplayMessage;
    if (record.role === "assistant" && record.api === NATIVE_API) {
      const agent = agentName(record.provider);
      open ??= { message: record, lines: [] };
      for (const block of blocks(record.content)) {
        if (block.type === "text" && typeof block.text === "string") {
          if (block.text.trim()) open.lines.push(block.text.trim());
        } else if (block.type === "toolCall") {
          if (typeof block.id === "string") nativeCalls.add(block.id);
          open.lines.push(
            `[${agent} used ${String(block.name ?? "a tool")}${argumentText(block.arguments)}]`,
          );
        }
        // Native reasoning is not replayed: no other model can verify it.
      }
      continue;
    }
    if (
      record.role === "toolResult" &&
      typeof record.toolCallId === "string" &&
      nativeCalls.has(record.toolCallId)
    ) {
      // The CLI ran the call within its own turn; its result belongs with the call.
      open ??= { message: { role: "assistant", api: NATIVE_API }, lines: [] };
      open.lines.push(resultText(record));
      continue;
    }
    close();
    replayed.push(message);
  }
  close();
  return replayed;
}

function agentName(provider: unknown): string {
  return isAgentRuntimeId(provider)
    ? AGENT_RUNTIME_DEFINITIONS[provider].name
    : "The coding agent";
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content)
    ? content.filter(
        (block): block is Block => !!block && typeof block === "object",
      )
    : [];
}

function argumentText(args: unknown): string {
  if (!args || typeof args !== "object" || !Object.keys(args).length) return "";
  const text = JSON.stringify(args);
  return `: ${text.length > MAX_ARGUMENTS ? `${text.slice(0, MAX_ARGUMENTS)}…` : text}`;
}

function resultText(result: ReplayMessage): string {
  const parts = blocks(result.content).map((block) =>
    block.type === "text" && typeof block.text === "string"
      ? block.text
      : block.type === "image"
        ? "[image]"
        : "",
  );
  const text = parts.join("\n").trim();
  const clipped =
    text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}…` : text;
  return `${result.isError === true ? "Failed" : "Result"}: ${clipped || "(no output)"}`;
}
