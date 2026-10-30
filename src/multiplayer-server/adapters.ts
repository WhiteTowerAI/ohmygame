import type {
  MultiplayerGameAdapter,
  MultiplayerGameState,
  MultiplayerManifestConfig,
  TurnCommand,
} from "../shared/multiplayer-protocol.js";
import { createGameAdapter, spawnArenaPlayers, spawnRoamPlayer, stepArena, stepRoam } from "./game.js";
import { createGomokuAdapter } from "./gomoku.js";

export type GameAdapter = MultiplayerGameAdapter<
  MultiplayerGameState,
  TurnCommand
>;

export type BuiltInAdapterId = "gomoku" | "stones" | "arena" | "roam";

/** The mode each shipped rules adapter plays. */
const BUILT_IN_MODES: Record<BuiltInAdapterId, MultiplayerManifestConfig["mode"]> = {
  gomoku: "turn-based",
  stones: "turn-based",
  arena: "realtime",
  roam: "realtime",
};

/** The rules shipped with the service. */
export function createBuiltInAdapter(id: BuiltInAdapterId): GameAdapter {
  if (id === "gomoku") return createGomokuAdapter();
  const adapter = createGameAdapter(BUILT_IN_MODES[id]);
  if (id === "arena") {
    adapter.step = stepArena;
    adapter.onPlayerJoin = (state, playerId) => spawnArenaPlayers(state, playerId);
    adapter.onRoundStart = (state) => spawnArenaPlayers(state);
  }
  if (id === "roam") {
    // One explorer is enough to play; the shared map is the game.
    adapter.players = { ...adapter.players, min: 1 };
    adapter.step = stepRoam;
    adapter.onPlayerJoin = (state, playerId) => spawnRoamPlayer(state, playerId);
  }
  return adapter;
}

/** "exactly 2" or "2 to 8", for player count errors. */
export function describePlayerRange({ min, max }: GameAdapter["players"]): string {
  return min === max ? `exactly ${min}` : `${min} to ${max}`;
}

/** Only the service operator can register adapters; clients never upload executable rules. */
export function resolveGameAdapter(
  config: MultiplayerManifestConfig,
  custom: Record<string, GameAdapter> = {},
): GameAdapter {
  const id =
    config.adapterId ?? (config.mode === "turn-based" ? "stones" : "arena");
  let adapter: GameAdapter;
  if (Object.hasOwn(BUILT_IN_MODES, id)) {
    if (BUILT_IN_MODES[id as BuiltInAdapterId] !== config.mode)
      throw new Error("The rules adapter does not match the game mode.");
    adapter = createBuiltInAdapter(id as BuiltInAdapterId);
  } else if (Object.hasOwn(custom, id)) {
    adapter = custom[id]!;
    if (config.mode === "realtime" && !adapter.step)
      throw new Error("Realtime adapters must supply a simulation step.");
  } else throw new Error(`No server rules adapter registered for ${id}.`);
  // A room the rules cannot fill would let players join a match that never starts.
  if (config.maxClients < adapter.players.min || config.maxClients > adapter.players.max)
    throw new Error(`The ${id} rules need ${describePlayerRange(adapter.players)} players.`);
  return adapter;
}
