import type { AgentItem } from "../shared/contracts.js";

export interface AgentTurn {
  id: string;
  user?: Extract<AgentItem, { kind: "user" }>;
  items: AgentItem[];
  active: boolean;
}

export function projectAgentTurns(items: AgentItem[], activeTurnId?: string): AgentTurn[] {
  const grouped = new Map<string, AgentItem[]>();
  for (const item of items) {
    const turn = grouped.get(item.turnId);
    if (turn) turn.push(item);
    else grouped.set(item.turnId, [item]);
  }

  return [...grouped].map(([id, turnItems]) => {
    const user = turnItems.find((item): item is Extract<AgentItem, { kind: "user" }> => item.kind === "user");
    const timelineItems = turnItems.filter((item) => (
      item !== user &&
      !(item.kind === "compaction" && item.status === "complete")
    ));
    return {
      id,
      user,
      items: timelineItems,
      active: id === activeTurnId,
    };
  });
}
