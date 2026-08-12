import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createPlayApp } from "./play-app.js";
import { configureNetworkProxy } from "./proxy.js";

configureNetworkProxy();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env.local"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const dataDirectory = process.env.OPEN_GAME_DATA_DIR ?? path.join(repositoryRoot, ".data");
const play = createPlayApp({ dataDirectory, logger: true });
let app: ReturnType<typeof createApp> | undefined;
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([app?.close(), play.close()]);
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  const playAddress = await play.listen({
    host: process.env.PLAY_HOST ?? "localhost",
    port: Number(process.env.PLAY_PORT ?? 43111),
  });
  app = createApp({
    dataDirectory,
    accessToken: process.env.OPEN_GAME_DAEMON_TOKEN,
    allowedOrigins: (process.env.OPEN_GAME_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    logger: true,
    playOrigin: process.env.PLAY_ORIGIN ?? localhostOrigin(playAddress),
  });
  await app.listen({ host: process.env.DAEMON_HOST ?? "127.0.0.1", port: Number(process.env.DAEMON_PORT ?? 43110) });
} catch (error) {
  app?.log.error(error);
  await Promise.allSettled([app?.close(), play.close()]);
  process.exit(1);
}

function localhostOrigin(address: string): string {
  return `http://localhost:${new URL(address).port}`;
}
