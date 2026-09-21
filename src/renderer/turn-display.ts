import type { ThreadItem, ToolArtifact, Turn } from "../shared/contracts.js";
import { projectWorkItems, type WorkDisplayItem } from "./work-items.js";

type AssistantItem = Extract<ThreadItem, { type: "agentMessage" }>;

export interface TurnDisplay {
  user?: Extract<ThreadItem, { type: "userMessage" }>;
  work: WorkDisplayItem[];
  artifacts: ToolArtifact[];
  messages: ThreadItem[];
  finalMessages: AssistantItem[];
  working: boolean;
  status: Turn["status"];
  hadThinking: boolean;
  durationMs: number;
}

export function projectTurnDisplay(turn: Turn, now = Date.now(), waitingForInput = false): TurnDisplay {
  const active = turn.status === "inProgress";
  const user = turn.items.find((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
  const items = turn.items.filter((item) => item !== user && item.type !== "userInputRequest" && !isCancelledStatusMessage(item) &&
    !(item.type === "retry" && item.status === "completed"));
  const finalStarted = items.some(isFinalAnswer);
  const finalMessages = active ? [] : items.filter(isFinalAnswer);
  const processItems = active ? items : items.filter((item) => !isFinalAnswer(item));
  const activityItems = processItems.filter((item) => item.type !== "plan");
  const workStarted = activityItems.some((item) => item.type !== "reasoning" && isWorkItem(item));
  const durationMs = turnDurationMs(turn.items);
  const hadThinking = activityItems.some((item) => item.type === "reasoning");

  if (!active) {
    const workItems = activityItems.filter((item) => item.type !== "reasoning" && isWorkItem(item));
    return {
      user,
      work: projectWorkItems(workItems),
      artifacts: collectArtifacts(processItems),
      messages: activityItems.filter((item) => !isWorkItem(item)),
      finalMessages,
      working: false,
      status: turn.status,
      hadThinking,
      durationMs,
    };
  }

  const visibleItems = withoutInitialThinking(activityItems);
  const live = !finalStarted;
  const working = workStarted || hasVisibleAssistantText(visibleItems);
  const waiting = !waitingForInput && live && working && shouldShowWaiting(visibleItems, now);
  const work = projectWorkItems(visibleItems, { active: live, waiting });
  return {
    user,
    work,
    artifacts: collectArtifacts(processItems),
    messages: [],
    finalMessages,
    working,
    status: turn.status,
    hadThinking,
    durationMs,
  };
}

function turnDurationMs(items: ThreadItem[]): number {
  const timestamps = items.map((item) => item.timestamp)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return timestamps.length >= 2 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
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
  return item.type === "reasoning" || item.type === "dynamicToolCall" || item.type === "mcpToolCall" || item.type === "retry" || item.type === "imageRead" ||
    (item.type === "contextCompaction" && item.status === "inProgress") ||
    (item.type === "agentMessage" && item.phase !== "final_answer");
}

function isFinalAnswer(item: ThreadItem): item is AssistantItem {
  return item.type === "agentMessage" && item.phase === "final_answer";
}

function isCancelledStatusMessage(item: ThreadItem): item is AssistantItem {
  return item.type === "agentMessage" && item.status === "cancelled" && !item.text.trim();
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
