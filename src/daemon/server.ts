import { migrateMediaSettingsAtStartup } from "./media-settings-startup.js";
import { acquireProfileOwnership } from "./profile-ownership.js";
import { ProcessBrowserDriver } from "./browser-driver.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { takeAccessToken } from "./access-token.js";
import { createApp } from "./app.js";
import { ensureOhMyGamePiEnvironment } from "./pi-agent.js";
import { activateNetworkProxy } from "./proxy.js";
import { loadEnvironmentFiles } from "./environment.js";
import { NetworkSettingsService } from "./network-settings.js";
import { requestSystemProxy } from "./system-proxy-resolver.js";
import { ProcessPlaytestDriver } from "./playtest-driver.js";
import { PLUGIN_INDEX_URL } from "./plugin-market.js";
import { isLocalDebugEnabled, isLoopbackHostname } from "../shared/local-debug.js";
import type { ExternalMcpLauncher } from "../shared/external-mcp.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const development = process.argv.includes("--dev");
const mode = development ? "development" : "production";
loadEnvironmentFiles(repositoryRoot, mode);
// Processes the daemon starts inherit its environment, and none of them may call the daemon as the app.
const accessToken = await takeAccessToken(process.env, process.stdin);
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
  try {
    await app?.close();
    process.exit(0);
  } catch (error) {
    console.error("Could not close the daemon cleanly", error);
    process.exit(1);
  }
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.on("message", (value: unknown) => {
  if ((value as { channel?: string } | null)?.channel === "ohmygame:shutdown")
    void shutdown();
});

try {
  // Own settings before Pi setup, eager plugin loading or any profile migration.
  // Keep ownership through asynchronous shutdown; crash/kill releases OS locks too.
  const releaseProfile = acquireProfileOwnership([dataDirectory, piAgentDirectory]);
  process.once("exit", releaseProfile);
  // Before createApp's eager plugin indexing or any settings caches exist.
  const { minimax: minimaxMigration, seedance: seedanceMigration } = await migrateMediaSettingsAtStartup(dataDirectory, process.env.OHMYGAME_SAFE_MODE === "1");
  if (minimaxMigration.status === "deferred")
    console.warn("MiniMax settings migration deferred:", minimaxMigration.reasons.join(", "));
  else if (minimaxMigration.status === "migrated")
    console.info("MiniMax settings migrated to the verified Beta plugin");
  if (seedanceMigration.status === "deferred")
    console.warn("Seedance settings migration deferred:", seedanceMigration.reasons.join(", "));
  else if (seedanceMigration.status === "migrated")
    console.info("Seedance settings migrated to the verified Beta plugin");
  const minimaxSettingsMigrated = minimaxMigration.status === "migrated" || minimaxMigration.status === "committed";
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
    minimaxSettingsMigrated,
    seedanceSettingsMigrated: seedanceMigration.status === "migrated" || seedanceMigration.status === "committed",
    networkSettings,
    piAgentDirectory,
    bundledPluginsDirectory: process.env.OHMYGAME_BUNDLED_PLUGINS_DIR,
    pluginUiDirectory: process.env.OHMYGAME_PLUGIN_UI_DIR,
    ...(process.env.OHMYGAME_SAFE_MODE === "1" ? { pluginSafeMode: true } : {}),
    pluginIndexUrl: process.env.OHMYGAME_PLUGIN_INDEX_URL ?? PLUGIN_INDEX_URL,
    ...(process.env.OHMYGAME_PLUGIN_UI_PORT ? { pluginUiPort: Number(process.env.OHMYGAME_PLUGIN_UI_PORT) } : {}),
    preinstalledPluginsDirectory: process.env.OHMYGAME_PREINSTALLED_PLUGINS_DIR
      ?? path.join(repositoryRoot, ".runtime", "preinstalled-plugins"),
    examplesDirectory: process.env.OHMYGAME_EXAMPLES_DIR ?? path.join(repositoryRoot, ".runtime", "examples"),
    accessToken,
    allowedOrigins: (process.env.OHMYGAME_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Browser development reaches the daemon through the renderer's proxy,
    // so no origin is allowed, but the renderer still frames plugin pages.
    ...(process.env.OHMYGAME_PLUGIN_FRAME_ANCESTORS
      ? { pluginFrameAncestors: process.env.OHMYGAME_PLUGIN_FRAME_ANCESTORS.split(",") }
      : development && !process.env.OHMYGAME_ALLOWED_ORIGINS
        ? { pluginFrameAncestors: ["http://127.0.0.1:43120", "http://localhost:43120"] }
        : {}),
    logger: true,
    logDirectory: process.env.OHMYGAME_LOG_DIR,
    publishApiUrl: process.env.CLOUD_API_URL ?? process.env.PUBLISH_API_URL,
    localDebug: isLocalDebugEnabled(
      development && isLoopbackHostname(host),
      process.env.VITE_SUPABASE_URL,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    ),
    playtestDriver,
    browserDriver: process.env.OHMYGAME_BROWSER_IPC === "1" && process.connected ? new ProcessBrowserDriver() : undefined,
    ...externalAgentOptions(),
  });
  await app.listen({ host, port: Number(process.env.DAEMON_PORT ?? 43110) });
} catch (error) {
  if (app) app.log.error(error); else console.error(error);
  await app?.close();
  process.exit(1);
}

/** The launcher and Skill the desktop app ships, read once and kept from the processes the daemon starts. */
function externalAgentOptions(): { externalMcpLauncher?: ExternalMcpLauncher; externalAgentSkillDirectory?: string } {
  const launcher = process.env.OHMYGAME_EXTERNAL_MCP_LAUNCHER;
  const skill = process.env.OHMYGAME_EXTERNAL_SKILL_DIR;
  delete process.env.OHMYGAME_EXTERNAL_MCP_LAUNCHER;
  delete process.env.OHMYGAME_EXTERNAL_SKILL_DIR;
  return {
    ...(launcher ? { externalMcpLauncher: JSON.parse(launcher) as ExternalMcpLauncher } : {}),
    ...(skill ? { externalAgentSkillDirectory: skill } : {}),
  };
}
