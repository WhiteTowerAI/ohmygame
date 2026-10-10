import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { ensureOhMyGamePiEnvironment } from "./pi-agent.js";
import { activateNetworkProxy } from "./proxy.js";
import { loadEnvironmentFiles } from "./environment.js";
import { NetworkSettingsService } from "./network-settings.js";
import { requestSystemProxy } from "./system-proxy-resolver.js";
import { ProcessPlaytestDriver } from "./playtest-driver.js";
import { isLocalDebugEnabled, isLoopbackHostname } from "../shared/local-debug.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const development = process.argv.includes("--dev");
const mode = development ? "development" : "production";
loadEnvironmentFiles(repositoryRoot, mode);
const host = process.env.DAEMON_HOST ?? "127.0.0.1";
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
  const networkSettings = new NetworkSettingsService(dataDirectory, {
    environment: process.env,
    initialSystemProxy: process.env.OHMYGAME_SYSTEM_PROXY,
    resolveSystemProxy: process.connected ? requestSystemProxy : undefined,
  });
  await networkSettings.load();
  activateNetworkProxy(networkSettings.runtime());
  try {
    await ensureOhMyGamePiEnvironment(piAgentDirectory);
  } catch (error) {
    console.warn("Could not initialize the OhMyGame Pi environment; continuing without managed MCP configuration.", error);
  }
  app = createApp({
    dataDirectory,
    networkSettings,
    piAgentDirectory,
    bundledPluginsDirectory: process.env.OHMYGAME_BUNDLED_PLUGINS_DIR,
    preinstalledPluginsDirectory: process.env.OHMYGAME_PREINSTALLED_PLUGINS_DIR
      ?? path.join(repositoryRoot, ".runtime", "preinstalled-plugins"),
    examplesDirectory: process.env.OHMYGAME_EXAMPLES_DIR ?? path.join(repositoryRoot, ".runtime", "examples"),
    interactiveStoryPlayerDirectory: process.env.OHMYGAME_PLAYER_DIR,
    accessToken: process.env.OHMYGAME_DAEMON_TOKEN,
    allowedOrigins: (process.env.OHMYGAME_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    logger: true,
    publishApiUrl: process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL,
    localDebug: isLocalDebugEnabled(
      development && isLoopbackHostname(host),
      process.env.VITE_SUPABASE_URL,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    ),
    playtestDriver,
  });
  await app.listen({ host, port: Number(process.env.DAEMON_PORT ?? 43110) });
} catch (error) {
  if (app) app.log.error(error); else console.error(error);
  await app?.close();
  process.exit(1);
}
