import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublishApp } from "./app.js";
import { createSupabaseTokenVerifier } from "./auth.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env.local"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const supabaseUrl = process.env.SUPABASE_URL;
if (!supabaseUrl) throw new Error("SUPABASE_URL is required");

const platformPort = process.env.PORT;
const host = process.env.PUBLISH_HOST ?? (platformPort ? "0.0.0.0" : "127.0.0.1");
const port = Number(platformPort ?? process.env.PUBLISH_PORT ?? 43130);
const app = createPublishApp({
  dataDirectory: process.env.PUBLISH_DATA_DIR ?? path.join(repositoryRoot, ".data", "publish"),
  playOrigin: process.env.PUBLISH_PLAY_ORIGIN ?? `http://localhost:${port}`,
  verifyPublisherToken: createSupabaseTokenVerifier(supabaseUrl),
  preinstalledPluginsDirectory: process.env.OPEN_GAME_PREINSTALLED_PLUGINS_DIR
    ?? path.join(repositoryRoot, ".runtime", "preinstalled-plugins"),
  logger: true,
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}
