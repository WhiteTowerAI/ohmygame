import { LOCKSTEP_ADAPTER_ID, MULTIPLAYER_MAX_CLIENTS, OWNER_ADAPTER_ID, type MultiplayerManifestConfig } from "@ohmygame/sdk/protocol";
import { HOST_ADAPTER_ID } from "@ohmygame/sdk/host";
import { checkTickMs, createRoomAdapter, tickMsOf, type GameAdapter } from "@ohmygame/sdk/rules";
export { createRoomAdapter, finishMatch, nextTurn, TURN_SECONDS, type GameAdapter } from "@ohmygame/sdk/rules";

/** "exactly 2" or "2 to 8", for player count errors. */
export function describePlayerRange({ min, max }: GameAdapter["players"]): string {
  return min === max ? `exactly ${min}` : `${min} to ${max}`;
}

/**
 * The rules registered for a deployment's adapterId. Only the service operator registers
 * adapters; clients never upload executable rules. adapterId "host" needs none: a player's
 * browser runs the game's rules, and the service keeps only the room. Nor does "lockstep",
 * whose rules every player's browser runs: the service numbers frames at the deployment's tickMs.
 * Nor does "owner", where each page runs its own player and the service passes states on.
 */
export function resolveGameAdapter(
  config: MultiplayerManifestConfig,
  adapters: Record<string, GameAdapter> = {},
): GameAdapter {
  const id = config.adapterId;
  if (id === HOST_ADAPTER_ID && !Object.hasOwn(adapters, id))
    return { ...createRoomAdapter(config.mode, { min: 1, max: MULTIPLAYER_MAX_CLIENTS }), hosted: true };
  if ((id === LOCKSTEP_ADAPTER_ID || id === OWNER_ADAPTER_ID) && !Object.hasOwn(adapters, id)) {
    if (config.mode !== "realtime" || config.tickMs === undefined)
      throw new Error(`A ${id} deployment is realtime and names its tickMs.`);
    checkTickMs(config.tickMs);
    const room = createRoomAdapter("realtime", { min: 1, max: MULTIPLAYER_MAX_CLIENTS });
    return id === LOCKSTEP_ADAPTER_ID ? { ...room, lockstep: true, tickMs: config.tickMs } : { ...room, owner: true, tickMs: config.tickMs };
  }
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
