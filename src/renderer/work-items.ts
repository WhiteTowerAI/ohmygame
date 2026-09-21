import type { ThreadItem } from "../shared/contracts.js";
import { mcpServerName } from "./mcp-tool-presentation.js";

export type ToolItem = Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>;
type ThinkingItem = Extract<ThreadItem, { type: "reasoning" }>;
type ActivityItem = ToolItem | ThinkingItem;

export type WorkDisplayItem =
  | { kind: "item"; item: ThreadItem }
  | { kind: "tool-group"; id: string; tools: ToolItem[]; thinking: boolean }
  | { kind: "thinking"; id: string };

export function projectWorkItems(items: ThreadItem[], { active = false, waiting = false }: { active?: boolean; waiting?: boolean } = {}): WorkDisplayItem[] {
  const projected: WorkDisplayItem[] = [];
  let activity: ActivityItem[] = [];

  function flushActivity(includeThinking: boolean) {
    if (activity.length === 0) return;
    const tools = activity.filter((item): item is ToolItem => item.type === "dynamicToolCall" || item.type === "mcpToolCall");
    const latest = activity.at(-1);
    const thinking = Boolean(includeThinking && latest?.type === "reasoning" && latest.status === "inProgress");
    if (tools.length > 0) projected.push({ kind: "tool-group", id: activity[0].id, tools, thinking });
    else if (thinking && latest) projected.push({ kind: "thinking", id: latest.id });
    activity = [];
  }

  for (const item of items) {
    if (item.type === "dynamicToolCall" || item.type === "mcpToolCall" || item.type === "reasoning") {
      activity.push(item);
      continue;
    }
    flushActivity(false);
    projected.push({ kind: "item", item });
  }
  flushActivity(active);
  if (waiting) {
    const latest = projected.at(-1);
    if (latest?.kind === "tool-group") projected[projected.length - 1] = { ...latest, thinking: true };
    else projected.push({ kind: "thinking", id: "waiting" });
  }
  return projected;
}

export function toolGroupSummary(tools: ToolItem[]): string {
  const categories = new Map<string, ToolItem[]>();
  for (const tool of tools.filter((item) => item.status !== "failed")) {
    const category = toolCategory(tool);
    categories.set(category, [...(categories.get(category) ?? []), tool]);
  }

  const phrases = [...categories]
    .sort(([left], [right]) => categoryOrder(left) - categoryOrder(right))
    .map(([category, items]) => categoryPhrase(category, items));
  const failed = tools.filter((item) => item.status === "failed").length;
  if (failed > 0) phrases.push(failed === 1 ? "an action failed" : "actions failed");
  if (phrases.length === 0) return "Used tools";
  const summary = phrases.join(", ");
  return summary[0].toUpperCase() + summary.slice(1);
}

function toolCategory(tool: ToolItem): string {
  if (tool.type === "mcpToolCall") return `mcp:${tool.server ?? ""}`;
  const toolName = tool.tool;
  if (toolName === "edit" || toolName === "write") return "edit";
  if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return "read";
  if (toolName === "bash") return "command";
  return `tool:${toolName}`;
}

function categoryOrder(category: string): number {
  if (category === "edit") return 0;
  if (category === "read") return 1;
  if (category === "command") return 2;
  return 3;
}

function categoryPhrase(category: string, tools: ToolItem[]): string {
  if (category === "edit") return filePhrase("edited", tools);
  if (category === "read") return tools.length === 1 ? "read a file" : "read files";
  if (category === "command") return tools.length === 1 ? "ran a command" : "ran commands";
  if (category.startsWith("mcp:")) {
    const name = singularToolName(mcpServerName(category.slice("mcp:".length) || undefined));
    return tools.length === 1 ? `used ${indefiniteArticle(name)} ${name} tool` : `used ${name} tools`;
  }
  const toolName = category.slice("tool:".length);
  return tools.length === 1 ? `used ${indefiniteArticle(toolName)} ${toolName} tool` : `used ${toolName} tools`;
}

function filePhrase(action: string, tools: ToolItem[]): string {
  const targets = new Set(tools.map(toolTarget).filter(Boolean));
  const count = targets.size || tools.length;
  return count === 1 ? `${action} a file` : `${action} files`;
}

function indefiniteArticle(value: string): "a" | "an" {
  const firstWord = value.trim().split(/\s+/, 1)[0] ?? "";
  if (/^[A-Z]{2,}$/.test(firstWord)) return /^[AEFHILMNORSX]/.test(firstWord) ? "an" : "a";
  return /^[aeiou]/i.test(firstWord) ? "an" : "a";
}

function singularToolName(value: string): string {
  return value.replace(/\s+tools?$/i, "");
}

function toolTarget(tool: ToolItem): string {
  const args = record(tool.arguments);
  return text(args?.path) || text(args?.file_path);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
