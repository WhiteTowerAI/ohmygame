import type { AgentItem } from "../shared/contracts.js";

export interface AgentTurn {
  id: string;
  user?: Extract<AgentItem, { kind: "user" }>;
  work: AgentItem[];
  response?: Extract<AgentItem, { kind: "assistant" }>;
  active: boolean;
  status: "running" | "complete" | "cancelled" | "interrupted" | "error";
  startedAt?: number;
  completedAt?: number;
}

export function projectAgentTurns(items: AgentItem[], activeTurnId?: string): AgentTurn[] {
  const grouped = new Map<string, AgentItem[]>();
  for (const item of items) {
    const turn = grouped.get(item.turnId);
    if (turn) turn.push(item);
    else grouped.set(item.turnId, [item]);
  }

  return [...grouped].map(([id, turnItems]) => {
    const active = id === activeTurnId;
    const user = turnItems.find((item): item is Extract<AgentItem, { kind: "user" }> => item.kind === "user");
    const lastItem = turnItems.findLast((item) => !(item.kind === "compaction" && item.status === "complete"));
    const response = !active && lastItem?.kind === "assistant" ? lastItem : undefined;
    const work = turnItems.filter((item) => (
      item !== user &&
      item !== response &&
      !(item.kind === "assistant" && !item.text) &&
      !(item.kind === "compaction" && item.status === "complete")
    ));
    const timestamps = turnItems
      .map((item) => item.timestamp)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      id,
      user,
      work,
      response,
      active,
      status: turnStatus(active, response),
      ...(timestamps.length > 0 ? {
        startedAt: Math.min(...timestamps),
        ...(!active ? { completedAt: Math.max(...timestamps) } : {}),
      } : {}),
    };
  });
}

function turnStatus(
  active: boolean,
  response: Extract<AgentItem, { kind: "assistant" }> | undefined,
): AgentTurn["status"] {
  if (active) return "running";
  if (response?.status === "cancelled") return "cancelled";
  if (response?.status === "interrupted") return "interrupted";
  if (response?.status === "error") return "error";
  return "complete";
}
