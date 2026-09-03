import { glob, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  PLUGIN_MANIFEST_PATH,
  PERSONAL_MARKETPLACE,
  isPluginManifest,
  type PluginInstallCandidate,
  type PluginManifest,
  type ResolvedPluginManifest,
} from "../shared/plugins.js";
import { LocalPluginError } from "./local-plugins.js";

export interface DiscoveredPlugin extends PluginInstallCandidate {
  manifest: ResolvedPluginManifest;
}

export async function discoverPlugins(root: string): Promise<DiscoveredPlugin[]> {
  const marketplacePath = await firstExisting(root, [
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
  ]);
  if (marketplacePath) return discoverMarketplace(root, marketplacePath);

  const manifests: Array<{ path: string; format: "opengame" | "codex" | "claude" }> = [
    { path: PLUGIN_MANIFEST_PATH, format: "opengame" },
    { path: ".codex-plugin/plugin.json", format: "codex" },
    { path: ".claude-plugin/plugin.json", format: "claude" },
  ];
  for (const candidate of manifests) {
    if (!await exists(path.join(root, candidate.path))) continue;
    const manifest = candidate.format === "opengame"
      ? await readOpenGameManifest(path.join(root, candidate.path))
      : await normalizeManifest(root, await readJson(path.join(root, candidate.path)), candidate.format);
    return [await installCandidate(root, candidate.format, manifest, PERSONAL_MARKETPLACE)];
  }

  const packagePath = path.join(root, "package.json");
  if (await exists(packagePath)) {
    const packageJson = asRecord(await readJson(packagePath));
    if (packageJson.pi && typeof packageJson.pi === "object") {
      const manifest = await normalizePiPackage(root, packageJson);
      return [await installCandidate(root, "pi", manifest, PERSONAL_MARKETPLACE)];
    }
  }

  const skills = await conventionalSkills(root);
  if (skills.length) {
    const metadata = await skillMetadata(path.join(root, skills[0]!.slice(2)));
    const name = metadata.name && validName(metadata.name) ? metadata.name : slug(path.basename(root));
    const manifest: ResolvedPluginManifest = {
      name,
      description: metadata.description || `${displayName(name)} Agent Skills`,
      skills,
      interface: { displayName: displayName(name), shortDescription: metadata.description || `${skills.length} Agent Skill${skills.length === 1 ? "" : "s"}` },
    };
    return [await installCandidate(root, "agent-skills", manifest, PERSONAL_MARKETPLACE)];
  }
  throw new LocalPluginError("No supported Plugin or Agent Skills were found in this repository");
}

async function discoverMarketplace(root: string, manifestPath: string): Promise<DiscoveredPlugin[]> {
  const marketplace = asRecord(await readJson(manifestPath));
  if (!Array.isArray(marketplace.plugins)) throw new LocalPluginError("Plugin marketplace manifest is invalid");
  const marketplaceRef = marketplaceReference(marketplace);
  const format: DiscoveredPlugin["format"] = manifestPath.includes(".claude-plugin") ? "claude" : "codex";
  const candidates: DiscoveredPlugin[] = [];
  for (const rawEntry of marketplace.plugins) {
    const entry = asRecord(rawEntry);
    const sourceRoot = marketplaceSourceRoot(root, entry.source);
    const rawSkills = stringArray(entry.skills);
    let manifest: ResolvedPluginManifest;
    const nativePath = path.join(sourceRoot, PLUGIN_MANIFEST_PATH);
    const codexPath = path.join(sourceRoot, ".codex-plugin", "plugin.json");
    const claudePath = path.join(sourceRoot, ".claude-plugin", "plugin.json");
    if (await exists(nativePath)) manifest = await readOpenGameManifest(nativePath);
    else if (await exists(codexPath)) manifest = await normalizeManifest(sourceRoot, await readJson(codexPath), "codex");
    else if (await exists(claudePath)) manifest = await normalizeManifest(sourceRoot, await readJson(claudePath), "claude");
    else manifest = await normalizeManifest(sourceRoot, entry, format, rawSkills.length ? rawSkills : undefined);
    manifest = { ...manifest, skills: rebasePaths(root, sourceRoot, manifest.skills) };
    candidates.push({ ...await installCandidate(root, format, manifest, marketplaceRef), key: `marketplace:${marketplaceRef.id}:${manifest.name}` });
  }
  if (!candidates.length) throw new LocalPluginError("Plugin marketplace does not contain any plugins");
  return candidates;
}

async function normalizeManifest(
  root: string,
  value: unknown,
  format: "codex" | "claude",
  declaredSkills?: string[],
): Promise<ResolvedPluginManifest> {
  const source = asRecord(value);
  const ui = source.interface && typeof source.interface === "object" ? asRecord(source.interface) : {};
  const rawName = stringValue(source.name) || path.basename(root);
  const name = validName(rawName) ? rawName : slug(rawName);
  const skills = declaredSkills ?? stringArray(source.skills);
  const discovered = skills.length ? skills.map(relativePath) : await conventionalSkills(root);
  const description = stringValue(ui.shortDescription) || stringValue(source.description) || `${displayName(name)} plugin`;
  return {
    name,
    ...(semver(stringValue(source.version)) ? { version: stringValue(source.version)! } : {}),
    description,
    ...(discovered.length ? { skills: discovered.length === 1 ? discovered[0] : discovered } : {}),
    interface: {
      displayName: stringValue(ui.displayName) || displayName(name),
      shortDescription: description,
      ...(stringValue(ui.longDescription) ? { longDescription: stringValue(ui.longDescription) } : {}),
      ...(promptArray(ui.defaultPrompt).length ? { defaultPrompt: promptArray(ui.defaultPrompt) } : {}),
    },
  };
}

async function normalizePiPackage(root: string, source: Record<string, unknown>): Promise<ResolvedPluginManifest> {
  const pi = asRecord(source.pi);
  const rawName = stringValue(source.name) || path.basename(root);
  const name = validName(rawName) ? rawName : slug(rawName.replace(/^@[^/]+\//, ""));
  const declared = await expandPiSkills(root, stringArray(pi.skills));
  const skills = declared.length ? declared : await conventionalSkills(root);
  const description = stringValue(source.description) || `${displayName(name)} Pi package`;
  return {
    name,
    ...(semver(stringValue(source.version)) ? { version: stringValue(source.version)! } : {}),
    description,
    ...(skills.length ? { skills: skills.length === 1 ? skills[0] : skills } : {}),
    interface: { displayName: displayName(name), shortDescription: description },
  };
}

async function expandPiSkills(root: string, patterns: string[]): Promise<`./${string}`[]> {
  if (!patterns.length) return [];
  const included = patterns.filter((pattern) => !pattern.startsWith("!"));
  if (!included.length) return [];
  const excluded = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const matches = new Set<`./${string}`>();
  for await (const match of glob(included, { cwd: root, exclude: excluded })) matches.add(relativePath(match));
  return [...matches].sort();
}

async function installCandidate(
  root: string,
  format: DiscoveredPlugin["format"],
  manifest: ResolvedPluginManifest,
  marketplace: PluginInstallCandidate["marketplace"],
): Promise<DiscoveredPlugin> {
  const skills = Array.isArray(manifest.skills) ? manifest.skills : manifest.skills ? [manifest.skills] : [];
  return {
    key: `${format}:root`,
    name: manifest.name,
    displayName: manifest.interface?.displayName ?? displayName(manifest.name),
    description: manifest.interface?.shortDescription ?? manifest.description,
    skillCount: await countSkills(root, skills),
    format,
    marketplace,
    manifest,
  };
}

function marketplaceReference(source: Record<string, unknown>): PluginInstallCandidate["marketplace"] {
  const name = stringValue(source.name);
  if (!name || !validName(name)) throw new LocalPluginError("Plugin marketplace name is invalid");
  if (name === "opengame" || name === "personal") throw new LocalPluginError(`Plugin marketplace name is reserved: ${name}`);
  const ui = source.interface && typeof source.interface === "object" ? asRecord(source.interface) : {};
  return { id: name, displayName: stringValue(ui.displayName) || displayName(name) };
}

async function countSkills(root: string, declaredPaths: string[]): Promise<number> {
  const files = new Set<string>();
  for (const declaredPath of declaredPaths) {
    const target = path.resolve(root, declaredPath);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new LocalPluginError(`Invalid plugin resource path: ${declaredPath}`);
    }
    const stats = await lstat(target).catch(() => undefined);
    if (!stats) throw new LocalPluginError(`Plugin resource not found: ${declaredPath}`);
    if (stats.isFile()) {
      if (path.basename(target) !== "SKILL.md") throw new LocalPluginError("The skills path must point to a directory or SKILL.md");
      files.add(target);
      continue;
    }
    if (!stats.isDirectory()) throw new LocalPluginError("The skills path must point to a directory or SKILL.md");
    const discovered: string[] = [];
    await findSkills(root, target, discovered);
    for (const skill of discovered) files.add(path.resolve(root, skill));
  }
  return files.size;
}

async function conventionalSkills(root: string): Promise<string[]> {
  const paths: string[] = [];
  if (await exists(path.join(root, "SKILL.md"))) paths.push("./SKILL.md");
  const skillsRoot = path.join(root, "skills");
  if (await exists(skillsRoot)) await findSkills(root, skillsRoot, paths);
  return paths.sort();
}

async function findSkills(root: string, directory: string, result: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new LocalPluginError("Plugin directories must not contain symbolic links");
    if (entry.isDirectory()) await findSkills(root, target, result);
    else if (entry.isFile() && entry.name === "SKILL.md") result.push(relativePath(path.relative(root, target)));
  }
}

async function skillMetadata(skillPath: string): Promise<{ name?: string; description?: string }> {
  const content = await readFile(skillPath, "utf8");
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1];
  if (!frontmatter) return {};
  try {
    const metadata = asRecord(parseYaml(frontmatter, { maxAliasCount: 0 }));
    return { name: stringValue(metadata.name), description: stringValue(metadata.description) };
  } catch (cause) {
    throw new LocalPluginError(`Could not read Skill metadata: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function marketplaceSourceRoot(root: string, source: unknown): string {
  const sourceObject = source && typeof source === "object" ? asRecord(source) : undefined;
  const sourceType = sourceObject ? stringValue(sourceObject.source) : undefined;
  if (sourceType && sourceType !== "local") {
    throw new LocalPluginError(`Marketplace source type is not supported yet: ${sourceType}`);
  }
  const rawPath = typeof source === "string" ? source : sourceObject ? stringValue(sourceObject.path) : undefined;
  if (sourceObject && !rawPath) throw new LocalPluginError("Marketplace local source requires a path");
  if (!rawPath) return root;
  const resolved = path.resolve(root, rawPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new LocalPluginError("Marketplace plugin source escapes the repository");
  return resolved;
}

function rebasePaths(repositoryRoot: string, pluginRoot: string, value: ResolvedPluginManifest["skills"]): ResolvedPluginManifest["skills"] {
  if (!value) return undefined;
  const paths = (Array.isArray(value) ? value : [value]).map((item) => relativePath(path.relative(repositoryRoot, path.resolve(pluginRoot, item))));
  return paths.length === 1 ? paths[0] : paths;
}

async function readOpenGameManifest(manifestPath: string): Promise<PluginManifest> {
  const value = await readJson(manifestPath);
  if (!isPluginManifest(value)) throw new LocalPluginError("OpenGame Plugin manifest is invalid");
  return value;
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (cause) {
    throw new LocalPluginError(`Could not read ${path.basename(filePath)}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function firstExisting(root: string, paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) if (await exists(path.join(root, candidate))) return path.join(root, candidate);
  return undefined;
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LocalPluginError("Plugin metadata is invalid");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
}

function promptArray(value: unknown): string[] {
  return stringArray(value).slice(0, 3);
}

function relativePath(value: string): `./${string}` {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) throw new LocalPluginError(`Invalid plugin resource path: ${value}`);
  return `./${normalized}`;
}

function validName(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plugin";
}

function semver(value: string | undefined): boolean {
  return Boolean(value && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value));
}

function displayName(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
