/**
 * What the player has seen, across every game they start: when each Node was
 * first entered and each edge first taken. The Runtime keeps it apart from
 * the save, so starting a new game or editing the graph keeps it. IDs that
 * are no longer in the graph are ignored. Scenes read it with
 * `context.story.seen()`, for a story map or anything else that shows the
 * player's progress.
 */
export interface PlayableSeen {
  version: 1;
  nodes: Record<string, string>;
  edges: Record<string, string>;
}

export function emptyPlayableSeen(): PlayableSeen {
  return { version: 1, nodes: {}, edges: {} };
}

/** Reads a stored record; anything unreadable starts over. */
export function parsePlayableSeen(value: unknown): PlayableSeen {
  if (!isRecord(value) || value.version !== 1 || !isTimes(value.nodes) || !isTimes(value.edges)) return emptyPlayableSeen();
  return { version: 1, nodes: { ...value.nodes }, edges: { ...value.edges } };
}

function isTimes(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((time) => typeof time === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
