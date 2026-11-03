export { createMultiplayerServer, type MultiplayerServerOptions } from "./service.js";
export { compileGame } from "./define-game.js";
export type { GameAdapter } from "./adapters.js";
export {
  defineGame,
  type GameContext,
  type GameDefinition,
  type GameResult,
  type MoveContext,
  type MoveDefinition,
  type MoveFunction,
  type MoveOptions,
} from "@ohmygame/sdk/game";
export { findGameRules, loadGameRules, readLocalDeployment, startDevServer, GAME_RULES_FILES, type DevServerOptions } from "./dev.js";
