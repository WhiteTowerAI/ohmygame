import type { ThreadItem, ToolArtifact, Turn } from "../shared/contracts.js";
import { projectWorkItems, type WorkDisplayItem } from "./work-items.js";

type AssistantItem = Extract<ThreadItem, { type: "agentMessage" }>;

export interface TurnDisplay {
  user?: Extract<ThreadItem, { type: "userMessage" }>;
  work: WorkDisplayItem[];
  artifacts: ToolArtifact[];
  messages: ThreadItem[];
  finalMessages: AssistantItem[];
  active: boolean;
  failed: boolean;
  working: boolean;
  waiting: boolean;
  thinkingText?: string;
}

export function projectTurnDisplay(turn: Turn, now = Date.now(), waitingForInput = false): TurnDisplay {
  const active = turn.status === "inProgress";
  const user = turn.items.find((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
  const items = turn.items.filter((item) => item !== user && item.type !== "userInputRequest" &&
    !(item.type === "retry" && item.status === "completed") &&
    !(item.type === "contextCompaction" && item.status === "completed"));
  const finalStarted = items.some(isFinalAnswer);
  const finalMessages = active ? [] : items.filter(isFinalAnswer);
  const processItems = active ? items : items.filter((item) => !isFinalAnswer(item));
  const activityItems = processItems.filter((item) => item.type !== "plan");
  const workStarted = activityItems.some((item) => item.type !== "reasoning" && isWorkItem(item));

  if (!active) {
    const workItems = activityItems.filter((item) => item.type !== "reasoning" && isWorkItem(item));
    return {
      user,
      work: projectWorkItems(workItems),
      artifacts: collectArtifacts(processItems),
      messages: activityItems.filter((item) => !isWorkItem(item)),
      finalMessages,
      active: false,
      failed: turn.status === "failed",
      working: false,
      waiting: false,
    };
  }

  const visibleItems = withoutInitialThinking(activityItems);
  const live = !finalStarted;
  const working = workStarted || hasVisibleAssistantText(visibleItems);
  const waiting = !waitingForInput && live && working && shouldShowWaiting(visibleItems, now);
  const work = projectWorkItems(visibleItems, live);
  const thinking = processItems.findLast(isStreamingThinking);

  return {
    user,
    work,
    artifacts: collectArtifacts(processItems),
    messages: [],
    finalMessages,
    active: true,
    failed: false,
    working,
    waiting,
    thinkingText: thinking?.text,
  };
}

function collectArtifacts(items: ThreadItem[]): ToolArtifact[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if ((item.type !== "dynamicToolCall" && item.type !== "mcpToolCall") || !item.artifact || seen.has(item.artifact.path)) return [];
    seen.add(item.artifact.path);
    return [item.artifact];
  });
}

function hasVisibleAssistantText(items: ThreadItem[]): boolean {
  return items.some((item) => item.type === "agentMessage" && Boolean(item.text.trim()));
}

function isWorkItem(item: ThreadItem): boolean {
  return item.type === "reasoning" || item.type === "dynamicToolCall" || item.type === "mcpToolCall" || item.type === "retry" || item.type === "contextCompaction" ||
    (item.type === "agentMessage" && item.phase !== "final_answer");
}

function isFinalAnswer(item: ThreadItem): item is AssistantItem {
  return item.type === "agentMessage" && item.phase === "final_answer";
}

function isStreamingThinking(item: ThreadItem): item is Extract<ThreadItem, { type: "reasoning" }> {
  return item.type === "reasoning" && item.status === "inProgress";
}

function withoutInitialThinking(items: ThreadItem[]): ThreadItem[] {
  const firstVisible = items.findIndex((item) => item.type !== "reasoning");
  return firstVisible < 0 ? [] : items.slice(firstVisible);
}

function shouldShowWaiting(items: ThreadItem[], now: number): boolean {
  const latest = items.at(-1);
  if (!latest || (latest.type === "agentMessage" && latest.status === "inProgress" && !hasStalledAssistantText(items, now))) return false;
  if (latest.type === "retry" || (latest.type === "contextCompaction" && latest.status === "inProgress")) return false;
  return !items.some((item) => (item.type === "dynamicToolCall" || item.type === "mcpToolCall") && (item.status === "preparing" || item.status === "inProgress")) &&
    !items.some((item) => item.type === "reasoning" && item.status === "inProgress");
}

function hasStalledAssistantText(items: ThreadItem[], now: number): boolean {
  const latest = items.at(-1);
  return latest?.type === "agentMessage" && latest.status === "inProgress" && Boolean(latest.text.trim()) &&
    latest.timestamp !== undefined && now - latest.timestamp >= 1_000;
}
