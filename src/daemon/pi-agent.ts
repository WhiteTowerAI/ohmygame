import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { pluginCreatorSkill } from "./plugin-authoring.js";

/** Where @ohmygame/plugin-ui is: the desktop app names it, and a checkout has it in packages/. */
const PLUGIN_UI_DIRECTORY = process.env.OHMYGAME_PLUGIN_UI_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/plugin-ui");
let skillFiles: Promise<Record<string, string>> | undefined;

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
  await ensurePluginCreatorSkill(agentDir);
}

async function ensurePluginCreatorSkill(agentDir: string): Promise<void> {
  const directory = path.join(agentDir, "skills", "plugin-creator");
  const files = await (skillFiles ??= pluginCreatorSkill(PLUGIN_UI_DIRECTORY));
  for (const [name, contents] of Object.entries(files)) {
    const filePath = path.join(directory, name);
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      if (await readFile(filePath, "utf8") === contents) continue;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await writeConfig(filePath, contents);
  }
  // References an older app wrote and this one doesn't.
  const references = await readdir(path.join(directory, "references")).catch(() => []);
  await Promise.all(references
    .filter((name) => !(`references/${name}` in files))
    .map((name) => rm(path.join(directory, "references", name), { recursive: true, force: true })));
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
