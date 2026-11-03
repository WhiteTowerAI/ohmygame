import type { MultiplayerGameState, RealtimeInput } from "@ohmygame/sdk/protocol";
import { createRoomAdapter, finishMatch, type GameAdapter } from "@ohmygame/server/adapters";

const ARENA_SPAWN_RADIUS = 35;
/** Successive seats turn by the golden angle, so any number of players spreads around the ring. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Inputs expire after 250ms. Speed, arena bounds and victory are server rules. */
export function stepArena(
  state: MultiplayerGameState,
  inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>,
  now: number,
): MultiplayerGameState {
  const next = structuredClone(state);
  for (const player of next.players) {
    const entry = inputs.get(player.playerId);
    if (!player.connected || !entry || now - entry.at > 250) continue;
    const length = Math.max(1, Math.hypot(entry.input.x, entry.input.y));
    player.x = Math.max(0, Math.min(100, player.x + entry.input.x / length));
    player.y = Math.max(0, Math.min(100, player.y + entry.input.y / length));
    if (Math.hypot(player.x - 50, player.y - 50) < 4) {
      finishMatch(next, [player.playerId]);
      break;
    }
  }
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
    onPlayerJoin: (state, playerId) => spawnArenaPlayers(state, playerId),
    onRoundStart: (state) => spawnArenaPlayers(state),
  };
}
