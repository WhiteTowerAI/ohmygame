import type {
  MultiplayerGameAdapter,
  MultiplayerGameState,
  MultiplayerManifestConfig,
  TurnCommand,
} from "../shared/multiplayer-protocol.js";
import { createGameAdapter, stepArena } from "./game.js";
import { createGomokuAdapter } from "./gomoku.js";

export type GameAdapter = MultiplayerGameAdapter<
  MultiplayerGameState,
  TurnCommand
>;

/** Only the service operator can register adapters; clients never upload executable rules. */
export function resolveGameAdapter(
  config: MultiplayerManifestConfig,
  custom: Record<string, GameAdapter> = {},
): GameAdapter {
  const id =
    config.adapterId ?? (config.mode === "turn-based" ? "stones" : "arena");
  if (id === "gomoku") {
    if (config.mode !== "turn-based" || config.maxClients !== 2)
      throw new Error("Gomoku requires turn-based mode and maxClients 2.");
    return createGomokuAdapter();
  }
  if (id === "stones" || id === "arena") {
    if ((id === "stones") !== (config.mode === "turn-based"))
      throw new Error("The rules adapter does not match the game mode.");
    const adapter = createGameAdapter(config.mode);
    if (id === "arena") adapter.step = stepArena;
    return adapter;
  }
  if (Object.hasOwn(custom, id)) {
    const adapter = custom[id]!;
    if (config.mode === "realtime" && !adapter.step)
      throw new Error("Realtime adapters must supply a simulation step.");
    return adapter;
  }
  throw new Error(`No server rules adapter registered for ${id}.`);
}
