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
  return [...grouped].map(([id, turnItems]) => ({
    id,
    conversationId,
    status: id === activeTurnId ? "inProgress" : completedTurnStatus(turnItems),
    items: turnItems,
  }));
}

function completedTurnStatus(items: readonly ThreadItem[]): TurnStatus {
  const terminal = [...items].reverse().find((item) => item.type === "agentMessage");
  if (terminal?.type !== "agentMessage") return "completed";
  return terminal.status === "inProgress" ? "interrupted" : terminal.status;
}
