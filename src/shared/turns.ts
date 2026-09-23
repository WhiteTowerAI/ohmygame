import type { ThreadItem, Turn, TurnStatus } from "./contracts.js";

export function groupThreadItems(
  conversationId: string,
  items: readonly ThreadItem[],
  activeTurnId?: string,
): Turn[] {
  const grouped = new Map<string, ThreadItem[]>();
  for (const item of items) {
    const turn = grouped.get(item.turnId);
    if (turn) turn.push(item);
    else grouped.set(item.turnId, [item]);
  }
  return [...grouped].map(([id, turnItems]) => {
    const status = id === activeTurnId ? "inProgress" : completedTurnStatus(turnItems);
    return {
      id,
      conversationId,
      status,
      items: status === "inProgress" ? turnItems : finalizeTurnItems(turnItems, status),
    };
  });
}

export function finalizeTurnItems(items: readonly ThreadItem[], status: TurnStatus): ThreadItem[] {
  return items.map((item) => {
    if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") &&
      (item.status === "preparing" || item.status === "inProgress")) {
      return { ...item, status: "failed" };
    }
    if (item.type === "reasoning" && item.status === "inProgress") return { ...item, status: "completed" };
    if (item.type === "agentMessage" && item.status === "inProgress") {
      return { ...item, status: status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "interrupted" };
    }
    if (item.type === "contextCompaction" && item.status === "inProgress") {
      return { ...item, status: status === "cancelled" ? "cancelled" : status === "completed" ? "completed" : "failed" };
    }
    if (item.type === "retry" && item.status === "inProgress") return { ...item, status: "failed" };
    if (item.type === "userInputRequest" && item.status === "inProgress") {
      return { ...item, status: status === "cancelled" ? "cancelled" : "failed" };
    }
    return item;
  });
}

function completedTurnStatus(items: readonly ThreadItem[]): TurnStatus {
  const terminal = [...items].reverse().find((item) => item.type === "agentMessage");
  if (terminal?.type !== "agentMessage") return "completed";
  return terminal.status === "inProgress" ? "interrupted" : terminal.status;
}
