#!/usr/bin/env node
import path from "node:path";
import { startDevServer } from "./dev.js";

const USAGE = `Usage: ohmygame-server dev [game-directory]

Runs the game's multiplayer deployment from multiplayer.json on its local port,
with its own rules from server/rules.ts when it has them, and restarts when
the rules change.`;

const [command, directory, ...rest] = process.argv.slice(2);
if (command !== "dev" || rest.length) {
  console.error(USAGE);
  process.exit(command === "--help" || command === "-h" ? 0 : 1);
}
try {
  const server = await startDevServer({ workspace: path.resolve(directory ?? ".") });
  const stop = () => void server.stop().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause);
  process.exit(1);
}
