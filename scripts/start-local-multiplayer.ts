import { createBuiltInAdapters } from "@ohmygame/games";
import { startDevServer } from "@ohmygame/server";

const workspace = process.argv[2];
if (!workspace)
  throw new Error("Usage: bun run multiplayer:local <game-workspace>");
// OhMyGame's games may play the built-in rules as well as their own.
const server = await startDevServer({ workspace, adapters: createBuiltInAdapters() });
process.once("SIGINT", () => void server.stop());
process.once("SIGTERM", () => void server.stop());
