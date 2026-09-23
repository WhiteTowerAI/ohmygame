import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ensureOhMyGamePiEnvironment } from "./pi-agent.js";
import { configureNetworkProxy } from "./proxy.js";
import { ProcessPlaytestDriver } from "./playtest-driver.js";

configureNetworkProxy();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
try {
  process.loadEnvFile(path.join(repositoryRoot, ".env.local"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const dataDirectory = process.env.OHMYGAME_DATA_DIR ?? path.join(repositoryRoot, ".data");
const piAgentDirectory = process.env.PI_CODING_AGENT_DIR ?? path.join(dataDirectory, "pi-agent");
process.env.PI_CODING_AGENT_DIR = piAgentDirectory;
let app: ReturnType<typeof createApp> | undefined;
let shuttingDown = false;
const playtestDriver = process.env.OHMYGAME_PLAYTEST_IPC === "1" && process.connected
  ? new ProcessPlaytestDriver()
  : undefined;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app?.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  try {
    await ensureOhMyGamePiEnvironment(piAgentDirectory);
  } catch (error) {
    console.warn("Could not initialize the OhMyGame Pi environment; continuing without managed MCP configuration.", error);
  }
  app = createApp({
    dataDirectory,
    piAgentDirectory,
    bundledPluginsDirectory: process.env.OHMYGAME_BUNDLED_PLUGINS_DIR,
    preinstalledPluginsDirectory: process.env.OHMYGAME_PREINSTALLED_PLUGINS_DIR
      ?? path.join(repositoryRoot, ".runtime", "preinstalled-plugins"),
    accessToken: process.env.OHMYGAME_DAEMON_TOKEN,
    allowedOrigins: (process.env.OHMYGAME_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    logger: true,
    publishApiUrl: process.env.PUBLISH_API_URL,
    playtestDriver,
  });
  await app.listen({ host: process.env.DAEMON_HOST ?? "127.0.0.1", port: Number(process.env.DAEMON_PORT ?? 43110) });
} catch (error) {
  app?.log.error(error);
  await app?.close();
  process.exit(1);
}
