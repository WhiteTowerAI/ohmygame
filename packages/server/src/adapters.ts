import type { MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { checkTickMs, tickMsOf, type GameAdapter } from "@ohmygame/sdk/rules";
export { createRoomAdapter, finishMatch, nextTurn, TURN_SECONDS, type GameAdapter } from "@ohmygame/sdk/rules";

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
  if (adapter.mode !== config.mode)
    throw new Error(`The rules adapter does not match the game mode: the ${id} rules are ${adapter.mode}, so set mode to ${adapter.mode}.`);
  if (adapter.mode === "realtime" && !adapter.step)
    throw new Error("Realtime adapters must supply a simulation step.");
  if (adapter.mode === "realtime") checkTickMs(tickMsOf(adapter));
  // A room the rules cannot fill would let players join a match that never starts.
  if (config.maxClients < adapter.players.min || config.maxClients > adapter.players.max)
    throw new Error(`The ${id} rules need ${describePlayerRange(adapter.players)} players.`);
  return adapter;
}
