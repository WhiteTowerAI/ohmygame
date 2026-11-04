import type { MultiplayerGameState, RealtimeInput } from "@ohmygame/sdk/protocol";
import { createRoomAdapter, finishMatch, type GameAdapter } from "@ohmygame/server/adapters";
import { moveToward, validateDirection } from "./direction.js";

const ARENA_SPAWN_RADIUS = 35;
/** Successive seats turn by the golden angle, so any number of players spreads around the ring. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Map units a racer covers per second; the ring is 35 units from the goal. */
export const ARENA_UNITS_PER_SECOND = 20;

/** Speed, arena bounds and victory are server rules. Everyone who reaches the goal in the same tick wins together. */
export function stepArena(
  state: MultiplayerGameState,
  inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>,
  _now: number,
  dt: number,
): MultiplayerGameState {
  const next = structuredClone(state);
  for (const player of next.players) {
    const entry = inputs.get(player.playerId);
    if (!player.connected || !entry) continue;
    moveToward(player, entry.input, ARENA_UNITS_PER_SECOND, dt);
  }
  // Seat order must not decide a tie: every player in the goal after this tick's moves wins.
  const arrived = next.players.filter((player) => player.connected && Math.hypot(player.x - 50, player.y - 50) < 4);
  if (arrived.length) finishMatch(next, arrived.map((player) => player.playerId));
  return next;
}

/** Every seat starts the same distance from the centre goal, including a drop-in latecomer. */
export function spawnArenaPlayers(state: MultiplayerGameState, only?: string): MultiplayerGameState {
  const next = structuredClone(state);
  next.players.forEach((player, index) => {
    if (only !== undefined && player.playerId !== only) return;
    player.x = 50 + ARENA_SPAWN_RADIUS * Math.cos(index * GOLDEN_ANGLE);
    player.y = 50 + ARENA_SPAWN_RADIUS * Math.sin(index * GOLDEN_ANGLE);
  });
  return next;
}

/** A realtime race to the centre; reaching it ends the round. */
export function createArenaAdapter(): GameAdapter {
  return {
    ...createRoomAdapter("realtime"),
    step: stepArena,
    validateInput: validateDirection,
    onPlayerJoin: (state, playerId) => spawnArenaPlayers(state, playerId),
    onRoundStart: (state) => spawnArenaPlayers(state),
  };
}
