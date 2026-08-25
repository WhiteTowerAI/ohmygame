import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const MCP_ADAPTER_PACKAGE = "npm:pi-mcp-adapter@2.27.0";
const GODOT_MCP_SERVER = {
  command: "npx",
  args: ["-y", "@coding-solo/godot-mcp@0.1.1"],
};
const pendingConfiguration = new Map<string, Promise<void>>();

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

  const errors: ParseError[] = [];
  const parsed = parse(contents, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`OpenGame Pi MCP config is invalid: ${filePath}`);
  }
  const config = parsed as Record<string, unknown>;
  const configuredServers = config.mcpServers;
  if (configuredServers !== undefined && (!configuredServers || typeof configuredServers !== "object" || Array.isArray(configuredServers))) {
    throw new Error(`OpenGame Pi MCP config has an invalid mcpServers field: ${filePath}`);
  }
  if (JSON.stringify((configuredServers as Record<string, unknown> | undefined)?.["opengame-godot"]) === JSON.stringify(GODOT_MCP_SERVER)) return;

  const edits = modify(contents, ["mcpServers", "opengame-godot"], GODOT_MCP_SERVER, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });

  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, applyEdits(contents, edits), { mode: 0o600 });
  await rename(temporaryPath, filePath);
}
