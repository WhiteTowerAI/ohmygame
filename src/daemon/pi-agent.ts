import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.27.0";
const GODOT_MCP_SERVER = {
  command: "npx",
  args: ["-y", "@coding-solo/godot-mcp@0.1.1"],
};
const PLUGIN_CREATOR_SKILL = `---
name: plugin-creator
description: Create or update an OpenGame plugin from a natural-language request, validate it, and install it for the user.
---

# OpenGame Plugin Creator

Create a normal plugin directory inside the current workspace. Use a short kebab-case directory name.

Every plugin must contain \`.opengame-plugin/plugin.json\`:

\`\`\`json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What the plugin does.",
  "skills": "./skills/",
  "connections": ["opengame-godot"],
  "interface": {
    "displayName": "My Plugin",
    "shortDescription": "A short user-facing description."
  }
}
\`\`\`

Only include fields the plugin uses. The built-in Godot connection is \`opengame-godot\`. OpenGame's built-in media generation capabilities are available to skills automatically and are not declared in the plugin manifest.

Put each bundled skill at \`skills/<skill-name>/SKILL.md\`. Skills may include their own \`scripts/\`, \`references/\`, and \`assets/\` directories. Prefer skills and scripts for local workflows. Do not create a Pi extension, custom in-process tool, or MCP server.

After creating the files, call \`install_plugin\` with the plugin directory relative to the workspace. Installation is part of the requested workflow and does not require another confirmation. Fix validation errors and call it again if necessary.

In the final response, state that the plugin was created and installed, summarize its Skills and Connections, and include its source directory.
`;
const pendingConfiguration = new Map<string, Promise<void>>();

export interface PiMcpServer {
  id: string;
  enabled: boolean;
}

export function isOpenGameManagedPiPackage(source: string): boolean {
  return source === "npm:pi-mcp-adapter" || source.startsWith("npm:pi-mcp-adapter@");
}

export function withRequiredPiPackages(
  packages: ReturnType<SettingsManager["getPackages"]>,
): ReturnType<SettingsManager["getPackages"]> {
  const hasAdapter = packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry.source;
    return isOpenGameManagedPiPackage(source);
  });
  return hasAdapter ? packages : [...packages, MCP_ADAPTER_PACKAGE];
}

export function ensureOpenGamePiEnvironment(agentDir: string): Promise<void> {
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
  await ensureGodotMcpConfig(agentDir);
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

async function ensureGodotMcpConfig(agentDir: string): Promise<void> {
  const filePath = path.join(agentDir, "mcp.json");
  let contents = "{}\n";
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const config = parseMcpConfig(contents, filePath);
  const existingServer = config.mcpServers?.["opengame-godot"];
  const disabled = existingServer && typeof existingServer === "object" && !Array.isArray(existingServer)
    ? (existingServer as Record<string, unknown>).disabled === true
    : false;
  const server = disabled ? { ...GODOT_MCP_SERVER, disabled: true } : GODOT_MCP_SERVER;
  if (JSON.stringify(existingServer) === JSON.stringify(server)) return;

  const edits = modify(contents, ["mcpServers", "opengame-godot"], server, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });

  await writeConfig(filePath, applyEdits(contents, edits));
}

export async function listMcpServers(agentDir: string): Promise<PiMcpServer[]> {
  await ensureOpenGamePiEnvironment(agentDir);
  const filePath = path.join(agentDir, "mcp.json");
  const contents = await readFile(filePath, "utf8");
  const config = parseMcpConfig(contents, filePath);
  return Object.entries(config.mcpServers ?? {}).map(([id, value]) => ({
    id,
    enabled: !isDisabledMcpServer(value),
  }));
}

export async function setMcpServerEnabled(agentDir: string, serverId: string, enabled: boolean): Promise<void> {
  await ensureOpenGamePiEnvironment(agentDir);
  const filePath = path.join(agentDir, "mcp.json");
  const contents = await readFile(filePath, "utf8");
  const config = parseMcpConfig(contents, filePath);
  const current = config.mcpServers?.[serverId];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`OpenGame Pi MCP server is not configured: ${serverId}`);
  }
  const edits = modify(contents, ["mcpServers", serverId, "disabled"], enabled ? undefined : true, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  await writeConfig(filePath, applyEdits(contents, edits));
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

function parseMcpConfig(contents: string, filePath: string): { mcpServers?: Record<string, unknown> } {
  const errors: ParseError[] = [];
  const parsed = parse(contents, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenGame Pi MCP config is invalid: ${filePath}`);
  }
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (mcpServers !== undefined && (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers))) {
    throw new Error(`OpenGame Pi MCP config has an invalid mcpServers field: ${filePath}`);
  }
  return { ...(mcpServers ? { mcpServers: mcpServers as Record<string, unknown> } : {}) };
}

function isDisabledMcpServer(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).disabled === true);
}
