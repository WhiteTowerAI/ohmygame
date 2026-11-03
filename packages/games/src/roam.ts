import type { MultiplayerGameState, RealtimeInput } from "@ohmygame/sdk/protocol";
import { createRoomAdapter, TICK_MS, type GameAdapter } from "@ohmygame/server/adapters";
import { GOLDEN_ANGLE } from "./arena.js";

/** Map units a roaming player crosses per second; the 100-unit world takes about eight seconds. */
export const ROAM_UNITS_PER_SECOND = 12;
const ROAM_SPAWN_RADIUS = 6;

/** Free movement with no goal: rounds never finish, so players explore for as long as they stay. */
export function stepRoam(
  state: MultiplayerGameState,
  inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>,
  now: number,
): MultiplayerGameState {
  const next = structuredClone(state);
  const step = (ROAM_UNITS_PER_SECOND * TICK_MS) / 1000;
  for (const player of next.players) {
    const entry = inputs.get(player.playerId);
    if (!player.connected || !entry || now - entry.at > 250) continue;
    const length = Math.hypot(entry.input.x, entry.input.y);
    if (!length) continue;
    // Analogue input below full tilt walks slower; diagonals are no faster than straight lines.
    const scale = (step * Math.min(1, length)) / length;
    player.x = Math.max(0, Math.min(100, player.x + entry.input.x * scale));
    player.y = Math.max(0, Math.min(100, player.y + entry.input.y * scale));
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
  const room = createRoomAdapter("realtime");
  return {
    ...room,
    players: { ...room.players, min: 1 },
    step: stepRoam,
    onPlayerJoin: (state, playerId) => spawnRoamPlayer(state, playerId),
  };
}
