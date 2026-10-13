import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { PLUGIN_AUTHORING_RULES } from "./plugin-authoring.js";

const PLUGIN_CREATOR_SKILL = `---
name: plugin-creator
description: Create or update an OhMyGame plugin from a natural-language request, validate it, and install it for the user.
---

# OhMyGame Plugin Creator

Create a normal plugin directory inside the current workspace. Use a short kebab-case directory name.

${PLUGIN_AUTHORING_RULES}

OhMyGame's built-in media generation capabilities are available to Skills automatically and are not declared in the manifest. The built-in Godot connection ID is \`ohmygame-godot\`.

After creating the files, call \`install_plugin\` with the plugin directory relative to the workspace. Installation is part of the requested workflow and does not require another confirmation. Fix validation errors and retry if necessary.

In the final response, state what was created and installed, summarize its Skills and MCP services, and include its source directory.
`;
const pendingConfiguration = new Map<string, Promise<void>>();

export function isOhMyGameManagedPiPackage(source: string): boolean {
  return source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@");
}

export function withoutOhMyGameManagedPiPackages(
  packages: ReturnType<SettingsManager["getPackages"]>,
): ReturnType<SettingsManager["getPackages"]> {
  const retained = packages.filter((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return !isOhMyGameManagedPiPackage(source);
  });
  return retained.length === packages.length ? packages : retained;
}

export function ensureOhMyGamePiEnvironment(agentDir: string): Promise<void> {
  const directory = path.resolve(agentDir);
  const existing = pendingConfiguration.get(directory);
  if (existing) return existing;
  const configuration = configure(directory).finally(() => {
    if (pendingConfiguration.get(directory) === configuration) pendingConfiguration.delete(directory);
  });
  pendingConfiguration.set(directory, configuration);
  return configuration;
}

async function configure(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const settings = SettingsManager.create(agentDir, agentDir);
  const packages = settings.getGlobalSettings().packages ?? [];
  const migratedPackages = withoutOhMyGameManagedPiPackages(packages);
  if (migratedPackages !== packages) {
    settings.setPackages(migratedPackages);
    await settings.flush();
  }
  await ensurePluginCreatorSkill(agentDir);
}

async function ensurePluginCreatorSkill(agentDir: string): Promise<void> {
  const directory = path.join(agentDir, "skills", "plugin-creator");
  const filePath = path.join(directory, "SKILL.md");
  await mkdir(directory, { recursive: true });
  try {
    if (await readFile(filePath, "utf8") === PLUGIN_CREATOR_SKILL) return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await writeConfig(filePath, PLUGIN_CREATOR_SKILL);
}

async function writeConfig(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
