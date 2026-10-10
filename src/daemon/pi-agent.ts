import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

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
  "mcpServers": "./mcp.json",
  "configuration": {
    "api-key": { "type": "secret", "label": "API key", "required": true }
  },
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "A short user-facing description.",
    "longDescription": "A longer description for the Plugin detail page.",
    "defaultPrompt": ["Try this plugin with a concrete task."],
    "projectTypes": ["web-game"]
  }
}
\`\`\`

Only include fields the plugin uses. Supported project types are \`web-game\`, \`godot-game\`, \`interactive-story\`, and \`asset-canvas\`. For legacy shared providers, the built-in Godot connection ID is \`ohmygame-godot\`. OhMyGame's built-in media generation capabilities are available to skills automatically and are not declared in the plugin manifest.

Put each bundled skill at \`skills/<skill-name>/SKILL.md\`. Skills may include their own \`scripts/\`, \`references/\`, and \`assets/\` directories. Prefer skills and scripts for local workflows. You may declare an existing STDIO or HTTP MCP service in a mcp.json file containing { "mcpServers": { "service": { "url": "https://service.example/mcp", "headers": { "Authorization": "Bearer \${config.api-key}" } } } }. Configuration fields support text, secret, path, boolean and select. Never embed credentials in a package or ask the user to paste them into chat; direct them to the Plugin configuration form. Do not generate a new MCP server, Pi extension or custom in-process tool.

After creating the files, call \`install_plugin\` with the plugin directory relative to the workspace. Installation is part of the requested workflow and does not require another confirmation. Fix validation errors and call it again if necessary.

In the final response, state that the plugin was created and installed, summarize its Skills and MCP services, and include its source directory.
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
