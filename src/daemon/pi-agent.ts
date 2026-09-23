import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConnectionManager } from "./connections.js";

const MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.27.0";
const PLUGIN_CREATOR_SKILL = `---
name: plugin-creator
description: Create or update an OhMyGame plugin from a natural-language request, validate it, and install it for the user.
---

# OhMyGame Plugin Creator

Create a normal plugin directory inside the current workspace. Use a short kebab-case directory name.

Every plugin must contain \`.ohmygame-plugin/plugin.json\`:

\`\`\`json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What the plugin does.",
  "skills": "./skills/",
  "connections": ["ohmygame-godot"],
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "A short user-facing description.",
    "longDescription": "A longer description for the Plugin detail page.",
    "defaultPrompt": ["Try this plugin with a concrete task."],
    "projectTypes": ["web-game"]
  }
}
\`\`\`

Only include fields the plugin uses. Supported project types are \`web-game\`, \`godot-game\`, \`interactive-drama\`, and \`asset-canvas\`. The built-in Godot connection is \`ohmygame-godot\`. OhMyGame's built-in media generation capabilities are available to skills automatically and are not declared in the plugin manifest.

Put each bundled skill at \`skills/<skill-name>/SKILL.md\`. Skills may include their own \`scripts/\`, \`references/\`, and \`assets/\` directories. Prefer skills and scripts for local workflows. Do not create a Pi extension, custom in-process tool, or MCP server.

After creating the files, call \`install_plugin\` with the plugin directory relative to the workspace. Installation is part of the requested workflow and does not require another confirmation. Fix validation errors and call it again if necessary.

In the final response, state that the plugin was created and installed, summarize its Skills and Connections, and include its source directory.
`;
const pendingConfiguration = new Map<string, Promise<void>>();

export interface PiMcpServer {
  id: string;
  enabled: boolean;
}

export function isOhMyGameManagedPiPackage(source: string): boolean {
  return source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@");
}

export function withRequiredPiPackages(
  packages: ReturnType<SettingsManager["getPackages"]>,
): ReturnType<SettingsManager["getPackages"]> {
  const hasAdapter = packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return isOhMyGameManagedPiPackage(source);
  });
  return hasAdapter ? packages : [...packages, MCP_ADAPTER_PACKAGE];
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
  const requiredPackages = withRequiredPiPackages(packages);
  if (requiredPackages !== packages) {
    settings.setPackages(requiredPackages);
    await settings.flush();
  }
  await new ConnectionManager(agentDir).ensurePresets();
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

export async function listMcpServers(agentDir: string): Promise<PiMcpServer[]> {
  await ensureOhMyGamePiEnvironment(agentDir);
  return (await new ConnectionManager(agentDir).list()).map(({ id, enabled }) => ({ id, enabled }));
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
