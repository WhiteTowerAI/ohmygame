import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { configureNetworkProxy } from "./proxy.js";

configureNetworkProxy();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env.local"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const dataDirectory = process.env.OPEN_GAME_DATA_DIR ?? path.join(repositoryRoot, ".data");
let app: ReturnType<typeof createApp> | undefined;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  app = createApp({
    dataDirectory,
    accessToken: process.env.OPEN_GAME_DAEMON_TOKEN,
    allowedOrigins: (process.env.OPEN_GAME_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    logger: true,
    publishApiUrl: process.env.PUBLISH_API_URL,
    publishToken: process.env.PUBLISH_TOKEN,
  });
  await app.listen({ host: process.env.DAEMON_HOST ?? "127.0.0.1", port: Number(process.env.DAEMON_PORT ?? 43110) });
} catch (error) {
  app?.log.error(error);
  await app?.close();
  process.exit(1);
}
