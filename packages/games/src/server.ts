import { readFile } from "node:fs/promises";
import { createMultiplayerServer, publishedGameCheck } from "@ohmygame/server";
import { PostgresGameDataStore } from "@ohmygame/server/postgres";
import { createBuiltInAdapters } from "./index.js";

// OhMyGame's hosted service: the operator's deployment registry, played with the built-in rules.
const deploymentsFile = process.env.MULTIPLAYER_DEPLOYMENTS_FILE;
if (!deploymentsFile)
  throw new Error(
    "Set MULTIPLAYER_DEPLOYMENTS_FILE to a trusted deployment registry JSON file.",
  );
const deployments = JSON.parse(await readFile(deploymentsFile, "utf8"));
if (!Array.isArray(deployments))
  throw new Error("The deployment registry must be an array.");
// Cloud saves and leaderboards, for games published to OhMyGame, when a database is configured.
const databaseUrl = process.env.GAME_DATA_DATABASE_URL;
const cloudApiUrl = process.env.OHMYGAME_CLOUD_API_URL;
if (databaseUrl && !cloudApiUrl)
  throw new Error("Set OHMYGAME_CLOUD_API_URL so cloud saves serve only games published to OhMyGame.");
let gameData;
if (databaseUrl) {
  const store = new PostgresGameDataStore({ connection: databaseUrl });
  await store.migrate();
  gameData = {
    store,
    allowGame: publishedGameCheck(cloudApiUrl!),
    adminToken: process.env.GAME_DATA_ADMIN_TOKEN || undefined,
  };
}
const service = createMultiplayerServer({
  deployments,
  adapters: createBuiltInAdapters(),
  auth: {
    guestSecret: process.env.MULTIPLAYER_GUEST_SECRET ?? "",
    // The OhMyGame account service whose game tokens sign players in; guests only without it.
    accountIssuer: process.env.OHMYGAME_ACCOUNT_ISSUER || undefined,
  },
  databasePath: process.env.MULTIPLAYER_DATABASE_PATH ?? "multiplayer.sqlite",
  host: process.env.MULTIPLAYER_HOST,
  port: Number(process.env.PORT ?? process.env.MULTIPLAYER_PORT ?? 43130),
  maxRooms: Number(process.env.MULTIPLAYER_MAX_ROOMS ?? 100),
  publicAddress: process.env.MULTIPLAYER_PUBLIC_ADDRESS,
  // Behind the platform's ingress, per-address limits read the client from it.
  clientAddress: {
    clientIpHeader: process.env.MULTIPLAYER_CLIENT_IP_HEADER?.trim() || undefined,
    trustProxyHops: process.env.MULTIPLAYER_TRUST_PROXY_HOPS ? Number(process.env.MULTIPLAYER_TRUST_PROXY_HOPS) : undefined,
  },
  ...(gameData ? { gameData } : {}),
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await service.stop();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
try {
  await service.start();
  console.log(
    `Multiplayer service listening on ${service.host}:${service.port}`,
  );
} catch (cause) {
  await service.stop();
  throw cause;
}
