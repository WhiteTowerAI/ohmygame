import type { AgentItem } from "../shared/contracts.js";
import type { AgentTurn } from "./agent-turns.js";
import { projectWorkItems, type WorkDisplayItem } from "./work-items.js";

type AssistantItem = Extract<AgentItem, { kind: "assistant" }>;

export interface TurnDisplay {
  user?: Extract<AgentItem, { kind: "user" }>;
  work: WorkDisplayItem[];
  messages: AgentItem[];
  finalMessages: AssistantItem[];
  active: boolean;
  working: boolean;
  waiting: boolean;
  thinkingText?: string;
}

export function projectTurnDisplay(turn: AgentTurn, now = Date.now()): TurnDisplay {
  const finalStarted = turn.items.some(isFinalAnswer);
  const finalMessages = turn.active ? [] : turn.items.filter(isFinalAnswer);
  const processItems = turn.active ? turn.items : turn.items.filter((item) => !isFinalAnswer(item));
  const workStarted = processItems.some((item) => item.kind !== "thinking" && isWorkItem(item));

  if (!turn.active) {
    const workItems = processItems.filter((item) => item.kind !== "thinking" && isWorkItem(item));
    return {
      user: turn.user,
      work: projectWorkItems(workItems),
      messages: processItems.filter((item) => !isWorkItem(item)),
      finalMessages,
      active: false,
      working: false,
      waiting: false,
    };
  }

  const visibleItems = withoutInitialThinking(processItems);
  const live = !finalStarted;
  const working = workStarted || hasVisibleAssistantText(visibleItems);
  const waiting = live && working && shouldShowWaiting(visibleItems, now);
  const work = projectWorkItems(waiting ? withoutCurrentActivity(visibleItems) : visibleItems, live);
  const thinking = processItems.findLast(isStreamingThinking);

  return {
    user: turn.user,
    work,
    messages: [],
    finalMessages,
    active: true,
    working,
    waiting,
    thinkingText: thinking?.text,
  };
}

function hasVisibleAssistantText(items: AgentItem[]): boolean {
  return items.some((item) => item.kind === "assistant" && Boolean(item.text.trim()));
}

function isWorkItem(item: AgentItem): boolean {
  return item.kind === "thinking" || item.kind === "tool" || item.kind === "retry" || item.kind === "compaction" ||
    (item.kind === "assistant" && item.phase === "commentary");
}

function isFinalAnswer(item: AgentItem): item is AssistantItem {
  return item.kind === "assistant" && item.phase === "final_answer";
}

function isStreamingThinking(item: AgentItem): item is Extract<AgentItem, { kind: "thinking" }> {
  return item.kind === "thinking" && item.status === "streaming";
}

function withoutInitialThinking(items: AgentItem[]): AgentItem[] {
  const firstVisible = items.findIndex((item) => item.kind !== "thinking");
  return firstVisible < 0 ? [] : items.slice(firstVisible);
}

function shouldShowWaiting(items: AgentItem[], now: number): boolean {
  const latest = items.at(-1);
  if (!latest || (latest.kind === "assistant" && latest.status === "streaming" && !hasStalledAssistantText(items, now))) return false;
  if (latest.kind === "retry" || (latest.kind === "compaction" && latest.status === "running")) return false;
  return !items.some((item) => item.kind === "tool" && (item.status === "preparing" || item.status === "running")) &&
    !items.some((item) => item.kind === "thinking" && item.status === "streaming");
}

function hasStalledAssistantText(items: AgentItem[], now: number): boolean {
  const latest = items.at(-1);
  return latest?.kind === "assistant" && latest.status === "streaming" && Boolean(latest.text.trim()) &&
    latest.timestamp !== undefined && now - latest.timestamp >= 1_000;
}

function withoutCurrentActivity(items: AgentItem[]): AgentItem[] {
  let end = items.length;
  while (end > 0 && (items[end - 1].kind === "tool" || items[end - 1].kind === "thinking")) end -= 1;
  return items.slice(0, end);
}
