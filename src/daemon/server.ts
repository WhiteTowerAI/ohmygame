import { createApp } from "./app.js";
import { configureNetworkProxy } from "./proxy.js";

configureNetworkProxy();
const app = createApp({
  dataDirectory: process.env.OPEN_GAME_DATA_DIR,
  accessToken: process.env.OPEN_GAME_DAEMON_TOKEN,
  allowedOrigins: (process.env.OPEN_GAME_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  logger: true,
});
const shutdown = async () => { await app.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await app.listen({ host: process.env.DAEMON_HOST ?? "127.0.0.1", port: Number(process.env.DAEMON_PORT ?? 43110) });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
