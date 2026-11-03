import type {
  MultiplayerGameAdapter,
  MultiplayerGameState,
  MultiplayerManifestConfig,
  TurnCommand,
} from "@ohmygame/sdk/protocol";
export { createRoomAdapter, nextTurn, TICK_MS, TURN_SECONDS } from "./game.js";

export type GameAdapter = MultiplayerGameAdapter<
  MultiplayerGameState,
  TurnCommand
>;

/** "exactly 2" or "2 to 8", for player count errors. */
export function describePlayerRange({ min, max }: GameAdapter["players"]): string {
  return min === max ? `exactly ${min}` : `${min} to ${max}`;
}

/**
 * The rules registered for a deployment's adapterId. Only the service operator registers
 * adapters; clients never upload executable rules.
 */
export function resolveGameAdapter(
  config: MultiplayerManifestConfig,
  adapters: Record<string, GameAdapter> = {},
): GameAdapter {
  const id = config.adapterId;
  if (!Object.hasOwn(adapters, id)) throw new Error(`No server rules adapter registered for ${id}.`);
  const adapter = adapters[id]!;
  if (adapter.mode !== config.mode) throw new Error("The rules adapter does not match the game mode.");
  if (adapter.mode === "realtime" && !adapter.step)
    throw new Error("Realtime adapters must supply a simulation step.");
  // A room the rules cannot fill would let players join a match that never starts.
  if (config.maxClients < adapter.players.min || config.maxClients > adapter.players.max)
    throw new Error(`The ${id} rules need ${describePlayerRange(adapter.players)} players.`);
  return adapter;
}
