import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PERSONAL_MARKETPLACE,
  PLUGIN_MANIFEST_PATH,
  isPluginManifest,
  isPluginVersion,
  type PluginComponentSummary,
  type PluginDetail,
} from "../shared/plugins.js";

const LOCAL_PLUGIN_ID_PREFIX = "local:";
const MAX_PLUGIN_ENTRIES = 5_000;
const MAX_PLUGIN_SIZE = 50 * 1024 * 1024;
const MAX_PLUGIN_DEPTH = 64;

interface LocalPluginRecord {
  name: string;
  version: string;
  sourcePath: string;
}

export interface PluginCapabilityRegistry {
  tools(): readonly string[];
  connections(): Promise<readonly string[]>;
  reservedPluginDisplayNames(): readonly string[];
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

  constructor(dataDirectory: string, private readonly capabilities?: PluginCapabilityRegistry) {
    this.#pluginsDirectory = path.join(dataDirectory, "plugins", "personal");
    this.#indexPath = path.join(dataDirectory, "plugins", "personal-plugins.json");
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
        ? [`Could not load local plugin ${records[index]!.name}: ${errorMessage(result.reason)}`]
        : []),
    };
  }

  installed(): PluginDetail[] {
    return [...this.#loaded.values()];
  }

  async read(id: string): Promise<PluginDetail | undefined> {
    await this.#mutations;
    const name = localPluginName(id);
    if (!name) return undefined;
    const record = (await this.#readIndex()).find((item) => item.name === name);
    return record ? this.#readRecord(record) : undefined;
  }

  async install(sourcePath: string): Promise<PluginDetail> {
    return this.#mutate(() => this.#install(sourcePath));
  }

  async #install(sourcePath: string): Promise<PluginDetail> {
    if (!path.isAbsolute(sourcePath)) throw new LocalPluginError("Plugin directory must be an absolute path");
    const source = path.resolve(sourcePath);
    if (pathsOverlap(source, this.#pluginsDirectory)) {
      throw new LocalPluginError("Plugin source must be outside OpenGame's managed plugin directory");
    }
    const inspected = await inspectLocalPlugin(source, this.capabilities);
    const currentRecords = await this.#readIndex();
    const previousRecord = currentRecords.find((record) => record.name === inspected.name);
    if (previousRecord && path.resolve(previousRecord.sourcePath) !== source) {
      throw new LocalPluginError(`Plugin ${inspected.name} is already installed from another source`);
    }
    const otherPlugins = await Promise.allSettled(
      currentRecords.filter((record) => record.name !== inspected.name).map((record) => this.#readRecord(record)),
    );
    const existingDisplayNames = [
      ...(this.capabilities?.reservedPluginDisplayNames() ?? []),
      ...otherPlugins.flatMap((result) => result.status === "fulfilled" ? [result.value.displayName] : []),
    ];
    if (existingDisplayNames.some((name) => normalizedDisplayName(name) === normalizedDisplayName(inspected.displayName))) {
      throw new LocalPluginError(`Plugin display name is already in use: ${inspected.displayName}`);
    }
    await mkdir(this.#pluginsDirectory, { recursive: true });
    const temporary = path.join(this.#pluginsDirectory, `.${inspected.name}.${randomUUID()}.tmp`);
    const destination = this.#installedPath(inspected.name, inspected.version!);
    const backup = path.join(this.#pluginsDirectory, `.${inspected.name}.${randomUUID()}.backup`);
    let hasBackup = false;
    let installedReplacement = false;
    let committed = false;
    try {
      await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
      await inspectLocalPlugin(temporary, this.capabilities);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await rename(destination, backup);
        hasBackup = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      await rename(temporary, destination);
      installedReplacement = true;
      const installed = await this.#readRecord({ name: inspected.name, version: inspected.version!, sourcePath: source });
      const records = currentRecords.filter((record) => record.name !== inspected.name);
      records.push({ name: inspected.name, version: inspected.version!, sourcePath: source });
      await this.#writeIndex(records);
      committed = true;
      this.#loaded.set(installed.id, installed);
      if (previousRecord && previousRecord.version !== inspected.version) {
        await rm(this.#installedPath(previousRecord.name, previousRecord.version), { recursive: true, force: true }).catch(() => undefined);
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
      const name = localPluginName(id);
      if (!name) throw new LocalPluginError("Plugin is not a local plugin", 404);
      const records = await this.#readIndex();
      if (!records.some((record) => record.name === name)) throw new LocalPluginError("Plugin not found", 404);
      const record = records.find((item) => item.name === name)!;
      const destination = this.#installedPath(name, record.version);
      const removed = path.join(this.#pluginsDirectory, `.${name}.${randomUUID()}.removed`);
      try {
        await rename(destination, removed);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw new LocalPluginError("Installed plugin files are missing");
        throw cause;
      }
      try {
        await this.#writeIndex(records.filter((record) => record.name !== name));
      } catch (cause) {
        await rename(removed, destination);
        throw cause;
      }
      await rm(removed, { recursive: true, force: true }).catch(() => undefined);
      this.#loaded.delete(id);
    });
  }

  async installedPath(id: string): Promise<string | undefined> {
    const name = localPluginName(id);
    if (!name) return undefined;
    const record = (await this.#readIndex()).find((item) => item.name === name);
    return record ? this.#installedPath(record.name, record.version) : undefined;
  }

  async directoryPath(id: string): Promise<string | undefined> {
    const name = localPluginName(id);
    if (!name) return undefined;
    const record = (await this.#readIndex()).find((item) => item.name === name);
    if (!record) return undefined;
    try {
      if ((await lstat(record.sourcePath)).isDirectory()) return record.sourcePath;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    return this.#installedPath(record.name, record.version);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.then(operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readRecord(record: LocalPluginRecord): Promise<PluginDetail> {
    try {
      return await inspectLocalPlugin(this.#installedPath(record.name, record.version), this.capabilities);
    } catch (cause) {
      if (cause instanceof LocalPluginError) throw cause;
      throw new LocalPluginError(`Could not read local plugin ${record.name}: ${errorMessage(cause)}`);
    }
  }

  async #readIndex(): Promise<LocalPluginRecord[]> {
    try {
      const value = JSON.parse(await readFile(this.#indexPath, "utf8")) as unknown;
      if (!Array.isArray(value) || !value.every(isLocalPluginRecord)) {
        throw new LocalPluginError("Local plugin index is invalid");
      }
      return value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (cause instanceof LocalPluginError) throw cause;
      throw new LocalPluginError(`Could not read local plugin index: ${errorMessage(cause)}`);
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

  #installedPath(name: string, version: string): string {
    return path.join(this.#pluginsDirectory, name, version);
  }
}

async function inspectLocalPlugin(pluginRoot: string, capabilities?: PluginCapabilityRegistry): Promise<PluginDetail> {
  await validateBundle(pluginRoot);
  const manifestPath = path.join(pluginRoot, PLUGIN_MANIFEST_PATH);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LocalPluginError(`Plugin manifest not found at ${PLUGIN_MANIFEST_PATH}`);
    }
    throw new LocalPluginError(`Could not read plugin manifest: ${errorMessage(cause)}`);
  }
  if (!isPluginManifest(value)) throw new LocalPluginError("Plugin manifest is invalid");
  const manifest = value;
  const skills = manifest.skills ? await skillComponents(pluginRoot, manifest.skills) : [];
  const tools = await referencedComponents(manifest.tools, capabilities?.tools(), "Tool");
  const connections = await referencedComponents(manifest.connections, await capabilities?.connections(), "Connection");
  return {
    id: `${LOCAL_PLUGIN_ID_PREFIX}${manifest.name}`,
    name: manifest.name,
    displayName: manifest.interface?.displayName ?? displayName(manifest.name),
    description: manifest.interface?.shortDescription ?? manifest.description,
    version: manifest.version,
    marketplace: PERSONAL_MARKETPLACE,
    source: { type: "local" },
    installed: true,
    enabled: true,
    skills,
    tools,
    connections,
  };
}

async function validateBundle(root: string): Promise<void> {
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
      if (entryCount > MAX_PLUGIN_ENTRIES) throw new LocalPluginError("Plugin contains too many files and directories");
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new LocalPluginError("Plugin directories must not contain symbolic links");
      if (entry.isDirectory()) {
        await visit(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new LocalPluginError("Plugin directories may contain only files and directories");
      size += (await lstat(target)).size;
      if (size > MAX_PLUGIN_SIZE) throw new LocalPluginError("Plugin is larger than 50 MB");
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
    return [component(root, target, "Skill")];
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
  return files.sort().map((file) => component(root, file, "Skill"));
}

async function referencedComponents(ids: string[] | undefined, available: readonly string[] | undefined, label: string): Promise<PluginComponentSummary[]> {
  const known = available ? new Set(available) : undefined;
  for (const id of ids ?? []) {
    if (known && !known.has(id)) throw new LocalPluginError(`${label} is not available: ${id}`);
  }
  return (ids ?? []).map((id) => ({ id, name: displayName(id), enabled: true }));
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

function component(
  root: string,
  target: string,
  fallbackName: string,
): PluginComponentSummary {
  const id = path.relative(root, target).split(path.sep).join("/");
  const parent = path.basename(path.dirname(target));
  const base = path.basename(target, path.extname(target));
  const name = path.basename(target) === "SKILL.md" ? parent : base;
  return { id, name: displayName(name) || fallbackName, enabled: true };
}

function localPluginName(id: string): string | undefined {
  if (!id.startsWith(LOCAL_PLUGIN_ID_PREFIX)) return undefined;
  const name = id.slice(LOCAL_PLUGIN_ID_PREFIX.length);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ? name : undefined;
}

function isLocalPluginRecord(value: unknown): value is LocalPluginRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalPluginRecord>;
  return typeof record.name === "string" && localPluginName(`${LOCAL_PLUGIN_ID_PREFIX}${record.name}`) !== undefined &&
    isPluginVersion(record.version) && typeof record.sourcePath === "string" && path.isAbsolute(record.sourcePath);
}

function displayName(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizedDisplayName(value: string): string {
  return value.trim().toLowerCase();
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
