import type { ThreadItem } from "../shared/contracts.js";

export interface AgentTurn {
  id: string;
  user?: Extract<ThreadItem, { type: "userMessage" }>;
  items: ThreadItem[];
  active: boolean;
}

export function projectAgentTurns(items: ThreadItem[], activeTurnId?: string): AgentTurn[] {
  const grouped = new Map<string, ThreadItem[]>();
  for (const item of items) {
    const turn = grouped.get(item.turnId);
    if (turn) turn.push(item);
    else grouped.set(item.turnId, [item]);
  }

  return [...grouped].flatMap(([id, turnItems]) => {
    const user = turnItems.find((item): item is Extract<ThreadItem, { type: "userMessage" }> => item.type === "userMessage");
    const timelineItems = turnItems.filter((item) => (
      item !== user &&
      !(item.type === "contextCompaction" && item.status === "completed")
    ));
    if (!user && timelineItems.length === 0) return [];
    return [{
      id,
      user,
      items: timelineItems,
      active: id === activeTurnId,
    }];
  });
}
