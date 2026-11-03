import { startDevServer } from "@ohmygame/server";

const workspace = process.argv[2];
if (!workspace)
  throw new Error("Usage: bun run multiplayer:local <game-workspace>");
const server = await startDevServer({ workspace });
process.once("SIGINT", () => void server.stop());
process.once("SIGTERM", () => void server.stop());
