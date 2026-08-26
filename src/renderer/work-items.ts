import type { AgentItem } from "../shared/contracts.js";
import { mcpServerName } from "./mcp-tool-presentation.js";

export type ToolItem = Extract<AgentItem, { kind: "tool" | "mcp" }>;
type ThinkingItem = Extract<AgentItem, { kind: "thinking" }>;
type ActivityItem = ToolItem | ThinkingItem;

export type WorkDisplayItem =
  | { kind: "item"; item: AgentItem }
  | { kind: "tool-group"; id: string; tools: ToolItem[]; active?: ToolItem; thinking?: ThinkingItem };

export function projectWorkItems(items: AgentItem[], active = false): WorkDisplayItem[] {
  const projected: WorkDisplayItem[] = [];
  let activity: ActivityItem[] = [];

  function flushActivity(current: boolean) {
    if (activity.length === 0) return;
    const tools = activity.filter((item): item is ToolItem => item.kind === "tool" || item.kind === "mcp");
    const latest = activity.at(-1);
    const activeTool = current && latest && (latest.kind === "tool" || latest.kind === "mcp") && (latest.status === "preparing" || latest.status === "running")
      ? latest
      : undefined;
    const thinking = current && latest?.kind === "thinking" && latest.status === "streaming" ? latest : undefined;
    if (tools.length > 0 || thinking) {
      projected.push({ kind: "tool-group", id: activity[0].id, tools, active: activeTool, thinking });
    }
    activity = [];
  }

  for (const item of items) {
    if (item.kind === "tool" || item.kind === "mcp" || item.kind === "thinking") {
      activity.push(item);
      continue;
    }
    flushActivity(false);
    projected.push({ kind: "item", item });
  }
  flushActivity(active);
  return projected;
}

export function toolGroupSummary(tools: ToolItem[]): string {
  const categories = new Map<string, ToolItem[]>();
  for (const tool of tools.filter((item) => item.status !== "error")) {
    const category = toolCategory(tool);
    categories.set(category, [...(categories.get(category) ?? []), tool]);
  }

  const phrases = [...categories]
    .sort(([left], [right]) => categoryOrder(left) - categoryOrder(right))
    .map(([category, items]) => categoryPhrase(category, items));
  const failed = tools.filter((item) => item.status === "error").length;
  if (failed > 0) phrases.push(failed === 1 ? "one action failed" : `${failed} actions failed`);
  if (phrases.length === 0) return "Used tools";
  const summary = phrases.join(", ");
  return summary[0].toUpperCase() + summary.slice(1);
}

function toolCategory(tool: ToolItem): string {
  if (tool.kind === "mcp") return `mcp:${tool.server ?? ""}`;
  const toolName = tool.toolName;
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
  if (category === "command") return tools.length === 1 ? "ran a command" : `ran ${tools.length} commands`;
  if (category.startsWith("mcp:")) {
    const name = mcpServerName(category.slice("mcp:".length) || undefined);
    return tools.length === 1 ? `used ${name}` : `used ${name} ${tools.length} times`;
  }
  const toolName = category.slice("tool:".length);
  return tools.length === 1 ? `used ${toolName}` : `used ${toolName} ${tools.length} times`;
}

function filePhrase(action: string, tools: ToolItem[]): string {
  const targets = new Set(tools.map(toolTarget).filter(Boolean));
  const count = targets.size || tools.length;
  return count === 1 ? `${action} a file` : `${action} ${count} files`;
}

function toolTarget(tool: ToolItem): string {
  const args = record(tool.args);
  return text(args?.path) || text(args?.file_path);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
