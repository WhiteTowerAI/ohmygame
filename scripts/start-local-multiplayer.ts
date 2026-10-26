import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { createMultiplayerServer } from "../src/multiplayer-server/service.js";
import { isMultiplayerManifestConfig } from "../src/shared/multiplayer-protocol.js";

const workspace = process.argv[2];
if (!workspace)
  throw new Error("Usage: bun run multiplayer:local <game-workspace>");
const { multiplayer: config } = JSON.parse(
  await readFile(path.resolve(workspace, "multiplayer.json"), "utf8"),
);
if (
  !isMultiplayerManifestConfig(config, { allowLocalhost: true }) ||
  !config.serverUrl.startsWith("http:")
)
  throw new Error(
    "multiplayer.json must declare a local HTTP loopback deployment.",
  );
const endpoint = new URL(config.serverUrl);
if (!endpoint.port || endpoint.port === "0")
  throw new Error(
    "Choose a fixed local port in multiplayer.json and public/manifest.json.",
  );
const service = createMultiplayerServer({
  deployments: [config],
  auth: { guestSecret: randomBytes(32).toString("hex") },
  databasePath: ":memory:",
  host: endpoint.hostname === "[::1]" ? "::1" : "127.0.0.1",
  port: Number(endpoint.port),
  allowLocalhost: true,
});
process.once("SIGINT", () => void service.stop());
process.once("SIGTERM", () => void service.stop());
await service.start();
console.log(
  `Local Colyseus backend: ${config.serverUrl} (${config.adapterId ?? config.mode}). Rooms end when this process stops.`,
);
