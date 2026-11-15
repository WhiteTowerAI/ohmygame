import type { GameAdapter } from "@ohmygame/server";
import { createArenaAdapter } from "./arena.js";
import { createGomokuAdapter } from "./gomoku.js";
import { createRoamAdapter } from "./roam.js";
import { createStonesAdapter } from "./stones.js";

export { ARENA_UNITS_PER_SECOND, createArenaAdapter, spawnArenaPlayers, stepArena } from "./arena.js";
export { moveToward, validateDirection, type DirectionInput } from "./direction.js";
export { createGomokuAdapter, gomokuRules } from "./gomoku.js";
export { createRoamAdapter, ROAM_UNITS_PER_SECOND, spawnRoamPlayer, stepRoam } from "./roam.js";
export { createStonesAdapter } from "./stones.js";
export { MATCH_WINS } from "./match-board.js";

/** The rules OhMyGame offers its games. The service runs only the rules it is given. */
export type BuiltInAdapterId = "gomoku" | "stones" | "arena" | "roam";
export const BUILT_IN_ADAPTER_IDS: readonly BuiltInAdapterId[] = ["gomoku", "stones", "arena", "roam"];

export function createBuiltInAdapter(id: BuiltInAdapterId): GameAdapter {
  if (id === "gomoku") return createGomokuAdapter();
  if (id === "stones") return createStonesAdapter();
  if (id === "arena") return createArenaAdapter();
  return createRoamAdapter();
}

/** Every built-in rule set by adapterId, for createMultiplayerServer({ adapters }). */
export function createBuiltInAdapters(): Record<BuiltInAdapterId, GameAdapter> {
  return Object.fromEntries(BUILT_IN_ADAPTER_IDS.map((id) => [id, createBuiltInAdapter(id)])) as Record<
    BuiltInAdapterId,
    GameAdapter
  >;
}
