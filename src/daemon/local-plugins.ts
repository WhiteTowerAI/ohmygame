import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PERSONAL_MARKETPLACE,
  OHMYGAME_MARKETPLACE,
  PLUGIN_ARCHIVE_MAX_BYTES,
  PLUGIN_ARCHIVE_MAX_ENTRIES,
  PLUGIN_MANIFEST_PATH,
  isPluginManifest,
  isPluginVersion,
  type McpServerDefinition,
  type PluginComponentSummary,
  type PluginDetail,
  type PluginMarketplaceRef,
  type PluginManifest,
  type ResolvedPluginManifest,
  type PluginSource,
} from "../shared/plugins.js";
import { parseSkillMetadata } from "./skill-metadata.js";

const MAX_PLUGIN_DEPTH = 64;

export type PluginProvenance =
  | { type: "directory"; path: string }
  | { type: "git"; url: string; commit: string }
  | { type: "preinstalled"; pluginId: string; releaseId: string };

interface LocalPluginRecord {
  name: string;
  version?: string;
  provenance: PluginProvenance;
  manifest: ResolvedPluginManifest;
  marketplace: PluginMarketplaceRef;
}

export interface PluginBundleIdentity {
  idPrefix: string;
  marketplace: PluginMarketplaceRef;
  source: PluginSource;
}

export class LocalPluginError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "LocalPluginError";
  }
}

export class LocalPluginStore {
  readonly #pluginsDirectory: string;
  readonly #indexPath: string;
  readonly #loaded = new Map<string, PluginDetail>();
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#pluginsDirectory = path.join(dataDirectory, "plugins", "installed");
    this.#indexPath = path.join(dataDirectory, "plugins", "installed-plugins.json");
  }

  async list(): Promise<{ plugins: PluginDetail[]; errors: string[] }> {
    await this.#mutations;
    const records = await this.#readIndex();
    const results = await Promise.allSettled(records.map((record) => this.#readRecord(record)));
    const plugins = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    this.#loaded.clear();
    for (const plugin of plugins) this.#loaded.set(plugin.id, plugin);
    return {
      plugins,
      errors: results.flatMap((result, index) => result.status === "rejected"
        ? [`Could not load installed plugin ${records[index]!.name}: ${errorMessage(result.reason)}`]
        : []),
    };
  }

  installed(): PluginDetail[] {
    return [...this.#loaded.values()];
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    await this.#mutations;
    const record = (await this.#readIndex()).find((item) => pluginRecordId(item) === id);
    return record ? this.#readRecord(record) : undefined;
  }

  async install(
    sourcePath: string,
    provenance: PluginProvenance = { type: "directory", path: sourcePath },
    manifest?: ResolvedPluginManifest,
    marketplace: PluginMarketplaceRef = PERSONAL_MARKETPLACE,
  ): Promise<PluginDetail> {
    return this.#mutate(() => this.#install(sourcePath, provenance, manifest, marketplace));
  }

  async installPrepared(
    sourcePath: string,
    provenance: Extract<PluginProvenance, { type: "preinstalled" }>,
    manifest: PluginManifest,
  ): Promise<PluginDetail> {
    return this.#mutate(() => this.#install(sourcePath, provenance, manifest, OHMYGAME_MARKETPLACE, true));
  }

  async #install(
    sourcePath: string,
    provenance: PluginProvenance,
    normalizedManifest: ResolvedPluginManifest | undefined,
    marketplace: PluginMarketplaceRef,
    trustedMarketplace = false,
  ): Promise<PluginDetail> {
    if (!path.isAbsolute(sourcePath)) throw new LocalPluginError("Plugin directory must be an absolute path");
    const source = path.resolve(sourcePath);
    if (pathsOverlap(source, this.#pluginsDirectory)) {
      throw new LocalPluginError("Plugin source must be outside OhMyGame's managed plugin directory");
    }
    if (provenance.type === "directory" && path.resolve(provenance.path) !== source) {
      throw new LocalPluginError("Plugin directory provenance does not match its source");
    }
    validateMarketplace(marketplace, trustedMarketplace);
    const identity = pluginIdentity(marketplace, publicSource(provenance));
    const inspected = await inspectPluginBundle(source, identity, normalizedManifest);
    const manifest = normalizedManifest ?? await readPluginManifest(source);
    const currentRecords = await this.#readIndex();
    const previousRecord = currentRecords.find((record) => pluginRecordId(record) === inspected.id);
    if (previousRecord && sourceKey(previousRecord.provenance) !== sourceKey(provenance)) {
      throw new LocalPluginError(`Plugin ${inspected.name} is already installed from another source`);
    }
    const conflictingMarketplace = marketplace.id === PERSONAL_MARKETPLACE.id || provenance.type === "preinstalled" ? undefined : currentRecords.find((record) =>
      record.marketplace.id === marketplace.id && sourceKey(record.provenance) !== sourceKey(provenance));
    if (conflictingMarketplace) {
      throw new LocalPluginError(`Marketplace ${marketplace.id} is already installed from another source`);
    }
    await mkdir(this.#pluginsDirectory, { recursive: true });
    const temporary = path.join(this.#pluginsDirectory, `.${inspected.name}.${randomUUID()}.tmp`);
    const destination = this.#installedPath(marketplace.id, inspected.name, inspected.version);
    const backup = path.join(this.#pluginsDirectory, `.${inspected.name}.${randomUUID()}.backup`);
    let hasBackup = false;
    let installedReplacement = false;
    let committed = false;
    try {
      await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
      await inspectPluginBundle(temporary, identity, manifest);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await rename(destination, backup);
        hasBackup = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      await rename(temporary, destination);
      installedReplacement = true;
      const record = { name: inspected.name, version: inspected.version, provenance, manifest, marketplace };
      const installed = await this.#readRecord(record);
      const records = currentRecords.filter((item) => pluginRecordId(item) !== inspected.id);
      records.push(record);
      await this.#writeIndex(records);
      committed = true;
      this.#loaded.set(installed.id, installed);
      if (previousRecord && previousRecord.version !== inspected.version) {
        await rm(this.#installedPath(previousRecord.marketplace.id, previousRecord.name, previousRecord.version), { recursive: true, force: true }).catch(() => undefined);
      }
      return installed;
    } catch (cause) {
      if (!committed) {
        if (installedReplacement) await rm(destination, { recursive: true, force: true });
        if (hasBackup) await rename(backup, destination);
      }
      throw cause;
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(id: string): Promise<void> {
    return this.#mutate(async () => {
      const records = await this.#readIndex();
      const record = records.find((item) => pluginRecordId(item) === id);
      if (!record) throw new LocalPluginError("Plugin not found", 404);
      const destination = this.#installedPath(record.marketplace.id, record.name, record.version);
      const removed = path.join(this.#pluginsDirectory, `.${record.name}.${randomUUID()}.removed`);
      try {
        await rename(destination, removed);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new LocalPluginError("Installed plugin files are missing");
        throw cause;
      }
      try {
        await this.#writeIndex(records.filter((item) => pluginRecordId(item) !== id));
      } catch (cause) {
        await rename(removed, destination);
        throw cause;
      }
      await rm(removed, { recursive: true, force: true }).catch(() => undefined);
      this.#loaded.delete(id);
    });
  }

  async installedPath(id: string): Promise<string | undefined> {
    const record = (await this.#readIndex()).find((item) => pluginRecordId(item) === id);
    return record ? this.#installedPath(record.marketplace.id, record.name, record.version) : undefined;
  }

  async directoryPath(id: string): Promise<string | undefined> {
    const record = (await this.#readIndex()).find((item) => pluginRecordId(item) === id);
    if (!record) return undefined;
    try {
      if (record.provenance.type === "directory" && (await lstat(record.provenance.path)).isDirectory()) return record.provenance.path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return this.#installedPath(record.marketplace.id, record.name, record.version);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readRecord(record: LocalPluginRecord): Promise<PluginDetail> {
    try {
      const plugin = await inspectPluginBundle(
        this.#installedPath(record.marketplace.id, record.name, record.version),
        pluginIdentity(record.marketplace, publicSource(record.provenance)),
        record.manifest,
      );
      return plugin;
    } catch (cause) {
      if (cause instanceof LocalPluginError) throw cause;
      throw new LocalPluginError(`Could not read installed plugin ${record.name}: ${errorMessage(cause)}`);
    }
  }

  async #readIndex(): Promise<LocalPluginRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.#indexPath, "utf8")) as unknown;
      if (!Array.isArray(value) || !value.every(isLocalPluginRecord)) {
        throw new LocalPluginError("Installed plugin index is invalid");
      }
      return value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (cause instanceof LocalPluginError) throw cause;
      throw new LocalPluginError(`Could not read installed plugin index: ${errorMessage(cause)}`);
    }
  }

  async #writeIndex(records: LocalPluginRecord[]): Promise<void> {
    await mkdir(path.dirname(this.#indexPath), { recursive: true });
    const temporary = `${this.#indexPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.#indexPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #installedPath(marketplaceId: string, name: string, version: string | undefined): string {
    return marketplaceId === PERSONAL_MARKETPLACE.id
      ? path.join(this.#pluginsDirectory, "personal", name, version ?? "unversioned")
      : path.join(this.#pluginsDirectory, "marketplace", marketplaceId, name, version ?? "unversioned");
  }
}

function pluginIdentity(marketplace: PluginMarketplaceRef, source: PluginSource): PluginBundleIdentity {
  const idPrefix = marketplace.id === PERSONAL_MARKETPLACE.id ? "personal:"
    : marketplace.id === OHMYGAME_MARKETPLACE.id ? "ohmygame:"
    : `marketplace:${marketplace.id}:`;
  return { idPrefix, marketplace, source };
}

export async function inspectPluginBundle(
  pluginRoot: string,
  identity: PluginBundleIdentity,
  normalizedManifest?: ResolvedPluginManifest,
): Promise<PluginDetail> {
  await validatePluginBundle(pluginRoot);
  const manifest = normalizedManifest ?? await readPluginManifest(pluginRoot);
  const skills = manifest.skills
    ? (await Promise.all((Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills]).map((skillPath) => skillComponents(pluginRoot, skillPath)))).flat()
    : [];
  const connections = (manifest.connections ?? []).map((id) => ({
    id, name: displayName(id.replace(/^ohmygame-/, "")), enabled: true,
  }));
  const definitions = manifest.mcpServers ? await readPluginMcpServers(pluginRoot, manifest.mcpServers) : {};
  return {
    id: `${identity.idPrefix}${manifest.name}`,
    name: manifest.name,
    displayName: manifest.interface?.displayName ?? displayName(manifest.name),
    description: manifest.interface?.shortDescription ?? manifest.description,
    longDescription: manifest.interface?.longDescription,
    version: manifest.version,
    marketplace: identity.marketplace,
    source: identity.source,
    installed: true,
    enabled: true,
    skills,
    connections,
    mcpServers: Object.entries(definitions).map(([id, definition]) => ({ id, name: displayName(id), enabled: definition.disabled !== true, transport: definition.url ? "http" as const : "stdio" as const })),
    mcpConfigPath: manifest.mcpServers,
    configuration: manifest.configuration,
    defaultPrompts: manifest.interface?.defaultPrompt,
    projectTypes: manifest.interface?.projectTypes,
  };
}

async function readPluginManifest(pluginRoot: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginRoot, PLUGIN_MANIFEST_PATH);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new LocalPluginError(`OhMyGame Plugin manifest not found at ${PLUGIN_MANIFEST_PATH}`);
    throw new LocalPluginError(`Could not read plugin manifest: ${errorMessage(cause)}`);
  }
  if (!isPluginManifest(value)) throw new LocalPluginError("Plugin manifest is invalid");
  return value;
}

export async function validatePluginBundle(root: string): Promise<void> {
  let entryCount = 0;
  let size = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_PLUGIN_DEPTH) throw new LocalPluginError("Plugin directory is nested too deeply");
    let directoryEntries;
    try {
      directoryEntries = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      throw new LocalPluginError(`Could not read plugin directory: ${errorMessage(cause)}`);
    }
    for (const entry of directoryEntries) {
      entryCount += 1;
      if (entryCount > PLUGIN_ARCHIVE_MAX_ENTRIES) throw new LocalPluginError("Plugin contains too many files and directories");
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new LocalPluginError("Plugin directories must not contain symbolic links");
      if (entry.isDirectory()) {
        await visit(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new LocalPluginError("Plugin directories may contain only files and directories");
      size += (await lstat(target)).size;
      if (size > PLUGIN_ARCHIVE_MAX_BYTES) throw new LocalPluginError("Plugin is larger than 50 MB");
    }
  }
  const stats = await lstat(root).catch((cause) => {
    throw new LocalPluginError(`Could not open plugin directory: ${errorMessage(cause)}`);
  });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new LocalPluginError("Plugin source must be a directory");
  await visit(root, 0);
}

async function skillComponents(root: string, relativePath: string): Promise<PluginComponentSummary[]> {
  const target = await declaredPath(root, relativePath);
  const stats = await lstat(target);
  if (stats.isFile()) {
    if (path.basename(target) !== "SKILL.md") throw new LocalPluginError("The skills path must point to a directory or SKILL.md");
    return [await component(root, target, "Skill")];
  }
  if (!stats.isDirectory()) throw new LocalPluginError("The skills path must point to a directory or SKILL.md");
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(entryPath);
    }
  }
  await visit(target);
  if (!files.length) throw new LocalPluginError("The skills directory does not contain a SKILL.md file");
  return Promise.all(files.sort().map((file) => component(root, file, "Skill")));
}

async function declaredPath(root: string, relativePath: string): Promise<string> {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LocalPluginError(`Invalid plugin resource path: ${relativePath}`);
  }
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new LocalPluginError(`Plugin resource must not be a symbolic link: ${relativePath}`);
    return target;
  } catch (cause) {
    if (cause instanceof LocalPluginError) throw cause;
    throw new LocalPluginError(`Plugin resource not found: ${relativePath}`);
  }
}

async function component(
  root: string,
  target: string,
  fallbackName: string,
): Promise<PluginComponentSummary> {
  const id = path.relative(root, target).split(path.sep).join("/");
  const parent = path.basename(path.dirname(target));
  const base = path.basename(target, path.extname(target));
  const fallback = path.basename(target) === "SKILL.md" ? parent : base;
  try {
    const metadata = parseSkillMetadata(await readFile(target, "utf8"));
    return {
      id,
      name: displayName(metadata.name ?? fallback) || fallbackName,
      ...(metadata.description ? { description: metadata.description } : {}),
      enabled: true,
    };
  } catch (cause) {
    throw new LocalPluginError(`Could not read Skill metadata: ${errorMessage(cause)}`);
  }
}

function isLocalPluginRecord(value: unknown): value is LocalPluginRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalPluginRecord>;
  return isPluginName(record.name) && (record.version === undefined || isPluginVersion(record.version)) &&
    isPluginProvenance(record.provenance) && isResolvedPluginManifest(record.manifest) && isPluginMarketplace(record.marketplace);
}

function isResolvedPluginManifest(value: unknown): value is ResolvedPluginManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return isPluginManifest({ ...manifest, version: manifest.version ?? "0.0.0" });
}

function isPluginProvenance(value: unknown): value is PluginProvenance {
  if (!value || typeof value !== "object") return false;
  const provenance = value as Partial<PluginProvenance>;
  if (provenance.type === "directory") return typeof provenance.path === "string" && path.isAbsolute(provenance.path);
  if (provenance.type === "git") return typeof provenance.url === "string" && typeof provenance.commit === "string";
  return provenance.type === "preinstalled" && typeof provenance.pluginId === "string" && typeof provenance.releaseId === "string";
}

function isPluginMarketplace(value: unknown): value is PluginMarketplaceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marketplace = value as Partial<PluginMarketplaceRef>;
  return isPluginName(marketplace.id) && typeof marketplace.displayName === "string" && Boolean(marketplace.displayName.trim());
}

function validateMarketplace(marketplace: PluginMarketplaceRef, trusted = false): void {
  if (!isPluginMarketplace(marketplace)) throw new LocalPluginError("Plugin marketplace is invalid");
  if (marketplace.id === "ohmygame" && !trusted) {
    throw new LocalPluginError(`Plugin marketplace name is reserved: ${marketplace.id}`);
  }
}

function isPluginName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function pluginRecordId(record: Pick<LocalPluginRecord, "name" | "marketplace">): string {
  return record.marketplace.id === PERSONAL_MARKETPLACE.id
    ? `personal:${record.name}`
    : record.marketplace.id === OHMYGAME_MARKETPLACE.id
      ? `ohmygame:${record.name}`
    : `marketplace:${record.marketplace.id}:${record.name}`;
}

function publicSource(provenance: PluginProvenance): PluginSource {
  if (provenance.type === "directory") return { type: "directory" };
  if (provenance.type === "git") return { type: "git", url: provenance.url, commit: provenance.commit };
  return provenance;
}

function sourceKey(provenance: PluginProvenance): string {
  if (provenance.type === "directory") return `directory:${path.resolve(provenance.path)}`;
  if (provenance.type === "git") return `git:${provenance.url}`;
  return `preinstalled:${provenance.pluginId}`;
}

function displayName(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pathsOverlap(first: string, second: string): boolean {
  return containsPath(first, second) || containsPath(second, first);
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function readPluginMcpServers(root: string, relativePath = "./mcp.json"): Promise<Record<string, McpServerDefinition>> {
  const file = await declaredPath(root, relativePath);
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch { throw new LocalPluginError("Plugin MCP file must contain valid JSON"); }
  const servers = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).mcpServers : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new LocalPluginError("Plugin MCP file requires mcpServers");
  for (const [id, definition] of Object.entries(servers)) {
    if (!/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(id) || !isMcpServerDefinition(definition)) throw new LocalPluginError(`Invalid MCP server: ${id}`);
  }
  return servers as Record<string, McpServerDefinition>;
}

export function isMcpServerDefinition(value: unknown): value is McpServerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if ((typeof d.command === "string" && Boolean(d.command.trim())) === (typeof d.url === "string" && Boolean(d.url.trim()))) return false;
  if (d.args !== undefined && (!Array.isArray(d.args) || !d.args.every(a => typeof a === "string"))) return false;
  for (const key of ["env", "headers"]) if (d[key] !== undefined && (!d[key] || typeof d[key] !== "object" || Array.isArray(d[key]) || !Object.values(d[key] as object).every(v => typeof v === "string"))) return false;
  if (typeof d.url === "string" && !d.url.includes("${config.")) {
    try { if (!["http:", "https:"].includes(new URL(d.url).protocol)) return false; } catch { return false; }
  }
  return true;
}
