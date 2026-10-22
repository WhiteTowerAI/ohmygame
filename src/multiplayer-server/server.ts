import { readFile } from "node:fs/promises";
import { createMultiplayerServer } from "./service.js";

const deploymentsFile = process.env.MULTIPLAYER_DEPLOYMENTS_FILE;
if (!deploymentsFile)
  throw new Error(
    "Set MULTIPLAYER_DEPLOYMENTS_FILE to a trusted deployment registry JSON file.",
  );
const deployments = JSON.parse(await readFile(deploymentsFile, "utf8"));
if (!Array.isArray(deployments))
  throw new Error("The deployment registry must be an array.");
const service = createMultiplayerServer({
  deployments,
  auth: {
    guestSecret: process.env.MULTIPLAYER_GUEST_SECRET ?? "",
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  },
  databasePath: process.env.MULTIPLAYER_DATABASE_PATH ?? "multiplayer.sqlite",
  host: process.env.MULTIPLAYER_HOST,
  port: Number(process.env.PORT ?? process.env.MULTIPLAYER_PORT ?? 43130),
  maxRooms: Number(process.env.MULTIPLAYER_MAX_ROOMS ?? 100),
  publicAddress: process.env.MULTIPLAYER_PUBLIC_ADDRESS,
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
