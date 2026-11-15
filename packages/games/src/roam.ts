import { MULTIPLAYER_MAX_CLIENTS, type MultiplayerGameState, type RealtimeInput } from "@ohmygame/sdk/protocol";
import { createRoomAdapter, type GameAdapter } from "@ohmygame/server/adapters";
import { GOLDEN_ANGLE } from "./arena.js";
import { moveToward, validateDirection } from "./direction.js";

/** Map units a roaming player crosses per second; the 100-unit world takes about eight seconds. */
export const ROAM_UNITS_PER_SECOND = 12;
const ROAM_SPAWN_RADIUS = 6;

/** Free movement with no goal: rounds never finish, so players explore for as long as they stay. */
export function stepRoam(
  state: MultiplayerGameState,
  inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>,
  _now: number,
  dt: number,
): MultiplayerGameState {
  const next = structuredClone(state);
  for (const player of next.players) {
    const entry = inputs.get(player.playerId);
    if (player.connected && entry) moveToward(player, entry.input, ROAM_UNITS_PER_SECOND, dt);
  }
  return next;
}

/** A newcomer appears near the centre, a little apart from whoever arrived before. */
export function spawnRoamPlayer(state: MultiplayerGameState, playerId: string): MultiplayerGameState {
  const next = structuredClone(state);
  const index = next.players.findIndex((player) => player.playerId === playerId);
  const player = next.players[index];
  if (player) {
    player.x = 50 + ROAM_SPAWN_RADIUS * Math.cos(index * GOLDEN_ANGLE);
    player.y = 50 + ROAM_SPAWN_RADIUS * Math.sin(index * GOLDEN_ANGLE);
  }
  return next;
}

/** A shared map to wander; one explorer is enough to play. */
export function createRoamAdapter(): GameAdapter {
  return {
    ...createRoomAdapter("realtime", { min: 1, max: MULTIPLAYER_MAX_CLIENTS }),
    step: stepRoam,
    validateInput: validateDirection,
    onPlayerJoin: (state, playerId) => spawnRoamPlayer(state, playerId),
  };
}
