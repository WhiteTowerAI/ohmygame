import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { PluginManifestV2 } from "../shared/plugin-manifest.js";
import { pluginApiIssue } from "../shared/plugin-manifest.js";
import { pluginAppliesTo } from "../shared/project-runtime.js";
import {
  PROJECT_FILE_NAME,
  PROJECT_FILE_SCHEMA_URL,
  projectTypePlugin,
  validateProjectFile,
  type ProjectFile,
  type ProjectFileResult,
} from "../shared/project-file.js";
import type {
  PluginIndex,
  PluginIndexEntry,
  PluginSkillSummary,
} from "./plugin-index.js";

// Which plugins are on in a project, and why the others aren't.
//
// A project asks for plugins in its `ohmygame.json`; a person allows them.
// Allowing happens twice: once per plugin when it is installed (its
// capabilities, shown at install) and once per project folder when a project
// asks for it. Both are kept in the person's data, never in the project, and
// both are asked again when a version wants more than was allowed.

// --- The project file ------------------------------------------------------

async function writeAtomic(file: string, content: string, mode?: number) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      content,
      mode === undefined ? undefined : { mode },
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Reads `ohmygame.json`; undefined when the folder has none. */
export async function readProjectFile(
  folder: string,
): Promise<ProjectFileResult | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(folder, PROJECT_FILE_NAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issues: [`${PROJECT_FILE_NAME} is not JSON`] };
  }
  return validateProjectFile(value);
}

const projectWrites = new Map<string, Promise<unknown>>();

/**
 * Writes `ohmygame.json`, keeping keys this version doesn't know. Formatted
 * for people, since it is committed with the project. Writes to the same
 * folder run one at a time, so two changes don't drop each other.
 */
export async function writeProjectFile(
  folder: string,
  update: (file: ProjectFile) => ProjectFile,
  initial?: ProjectFile,
): Promise<ProjectFile> {
  return writeProjectFileAt(await projectFolderKey(folder), update, initial);
}

/** Like `writeProjectFile`, for a folder that is already a real path. */
function writeProjectFileAt(
  folder: string,
  update: (file: ProjectFile) => ProjectFile,
  initial?: ProjectFile,
): Promise<ProjectFile> {
  const run = (projectWrites.get(folder) ?? Promise.resolve()).then(() =>
    updateProjectFile(folder, update, initial),
  );
  const settled = run.catch(() => {});
  projectWrites.set(folder, settled);
  void settled.then(() => {
    if (projectWrites.get(folder) === settled) projectWrites.delete(folder);
  });
  return run;
}

async function updateProjectFile(
  folder: string,
  update: (file: ProjectFile) => ProjectFile,
  initial?: ProjectFile,
): Promise<ProjectFile> {
  const current = await readProjectFile(folder);
  if (current && !current.ok)
    throw new Error(
      `${PROJECT_FILE_NAME} is invalid: ${current.issues.join("; ")}`,
    );
  const base = current?.file ?? initial;
  if (!base) throw new Error(`${PROJECT_FILE_NAME} does not exist`);
  const next = update({ ...base, plugins: { ...base.plugins } });
  if (next.plugins && !Object.keys(next.plugins).length) delete next.plugins;
  const checked = validateProjectFile(next);
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  const ordered = { $schema: PROJECT_FILE_SCHEMA_URL, ...next };
  await writeAtomic(
    path.join(folder, PROJECT_FILE_NAME),
    `${JSON.stringify(ordered, null, 2)}\n`,
  );
  return ordered;
}

// --- Capabilities ----------------------------------------------------------

/** A manifest's capabilities as plain grants, such as `network:api.example.com`. */
export function capabilityGrants(
  manifest: Pick<PluginManifestV2, "capabilities">,
): string[] {
  const capabilities = manifest.capabilities ?? {};
  const grants = new Set<string>();
  if (capabilities.native) grants.add("native");
  if (capabilities["project.selection"]) grants.add("project.selection");
  if (capabilities["project.files"])
    grants.add(`project.files:${capabilities["project.files"]}`);
  if (capabilities.composer) grants.add("composer");
  if (capabilities.agent) grants.add("agent");
  if (capabilities.secrets) grants.add("secrets");
  for (const host of capabilities.network ?? []) grants.add(`network:${host}`);
  for (const command of capabilities.processes ?? [])
    grants.add(`process:${command}`);
  return [...grants].sort();
}

/** The grants in `requested` that `allowed` doesn't cover; writing files covers reading them. */
export function missingGrants(
  requested: readonly string[],
  allowed: readonly string[],
): string[] {
  const has = new Set(allowed);
  return requested.filter(
    (grant) =>
      !has.has(grant) &&
      !(grant === "project.files:read" && has.has("project.files:write")),
  );
}

// --- What the person allowed -----------------------------------------------

interface GrantsFile {
  schema: 1;
  /** Per plugin: its app switch and the capabilities allowed at install. */
  plugins: Record<string, { enabled: boolean; allowed: string[] }>;
  /** Per project folder (its real path), per plugin: what was allowed there. */
  projects: Record<string, Record<string, { allowed: string[] }>>;
}

/**
 * The person's plugin decisions: install consent, app switches, project
 * approvals. The daemon owns the file through one instance; each change still
 * starts from what is on disk, so a second writer can't bring back a
 * decision the first one took away.
 */
export class PluginGrants {
  #data: GrantsFile = { schema: 1, plugins: {}, projects: {} };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /**
   * Reads the decisions. A missing file, or one that isn't JSON any more,
   * means nothing was allowed yet; a file that can't be read is an error, so
   * a change never saves over decisions it couldn't see.
   */
  load(): Promise<void> {
    return this.#serial(async () => {
      this.#data = await this.#read();
    });
  }

  async #read(): Promise<GrantsFile> {
    let text: string | undefined;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let value: Partial<GrantsFile> | undefined;
    try {
      value = text === undefined ? undefined : JSON.parse(text);
    } catch {
      value = undefined;
    }
    return {
      schema: 1,
      plugins: value?.plugins ?? {},
      projects: value?.projects ?? {},
    };
  }

  plugin(id: string) {
    return this.#data.plugins[id];
  }

  project(folderKey: string, id: string) {
    return this.#data.projects[folderKey]?.[id];
  }

  /** Records install consent for a plugin's capabilities; a new plugin starts on. */
  consent(id: string, allowed: readonly string[]): Promise<void> {
    return this.#change((data) => {
      const current = data.plugins[id];
      data.plugins[id] = {
        enabled: current?.enabled ?? true,
        allowed: [...new Set([...(current?.allowed ?? []), ...allowed])].sort(),
      };
    });
  }

  /** Turning off a plugin not yet consented to keeps that choice, allowing nothing. */
  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.#change((data) => {
      const current = data.plugins[id];
      if (current) current.enabled = enabled;
      else if (!enabled) data.plugins[id] = { enabled, allowed: [] };
    });
  }

  approve(
    folderKey: string,
    id: string,
    allowed: readonly string[],
  ): Promise<void> {
    return this.#change((data) => {
      const project = (data.projects[folderKey] ??= {});
      const current = project[id]?.allowed ?? [];
      project[id] = { allowed: [...new Set([...current, ...allowed])].sort() };
    });
  }

  revoke(folderKey: string, id: string): Promise<void> {
    return this.#change((data) => {
      delete data.projects[folderKey]?.[id];
    });
  }

  /** Forgets a plugin everywhere, as when it is uninstalled. */
  forget(id: string): Promise<void> {
    return this.#change((data) => {
      delete data.plugins[id];
      for (const project of Object.values(data.projects)) delete project[id];
    });
  }

  /** Applies a change to what is on disk; it shows only once it is saved. */
  #change(change: (data: GrantsFile) => void): Promise<void> {
    return this.#serial(async () => {
      const data = await this.#read();
      change(data);
      await writeAtomic(this.file, `${JSON.stringify(data)}\n`, 0o600);
      this.#data = data;
    });
  }

  #serial(task: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => {});
    return run;
  }
}

/** Approvals are kept by the folder's real path, so a link or `..` doesn't split them. */
export async function projectFolderKey(folder: string): Promise<string> {
  return realpath(path.resolve(folder));
}

// --- Resolving a project ---------------------------------------------------

export type ProjectPluginStatus =
  /** On in this project. */
  | "active"
  /** Asked for, but no version of it is installed. */
  | "not-installed"
  /** Other versions are installed, not this one. */
  | "version-not-installed"
  /** Needs a newer or older OhMyGame plugin API. */
  | "incompatible"
  /** Turned off for the whole app. */
  | "disabled"
  /** Its `appliesTo` leaves out the project's type. */
  | "not-applicable"
  /** This version wants capabilities that weren't allowed at install. */
  | "needs-consent"
  /** Not yet allowed in this project folder, or this version wants more. */
  | "needs-approval";

export interface ProjectPluginState {
  id: string;
  version: string;
  status: ProjectPluginStatus;
  /** True for the plugin that provides the project's type. */
  providesType: boolean;
  entry?: PluginIndexEntry;
  /** Grants still to allow, for the two consent states. */
  missing?: string[];
  /** Installed versions, for `version-not-installed`. */
  installed?: string[];
}

export type ProjectPlugins =
  | {
      ok: true;
      file: ProjectFile;
      /** Whether the type's plugin is active; when not, the project opens with placeholders. */
      typeReady: boolean;
      plugins: ProjectPluginState[];
    }
  | { ok: false; issues: string[] };

/** Every plugin a project asks for, with whether it is on and, if not, why. */
export async function resolveProjectPlugins({
  folder,
  index,
  grants,
}: {
  folder: string;
  index: PluginIndex;
  grants: PluginGrants;
}): Promise<ProjectPlugins | undefined> {
  const key = await projectFolderKey(folder);
  const read = await readProjectFile(key);
  if (!read) return undefined;
  if (!read.ok) return read;
  const owner = projectTypePlugin(read.file.type);
  const plugins = Object.entries(read.file.plugins ?? {})
    .sort(([a], [b]) =>
      a === owner ? -1 : b === owner ? 1 : a.localeCompare(b),
    )
    .map(([id, version]): ProjectPluginState => {
      const base = { id, version, providesType: id === owner };
      const entry = index.get(id, version);
      if (!entry) {
        const installed = index.versions(id).map((item) => item.version);
        return installed.length
          ? { ...base, status: "version-not-installed", installed }
          : { ...base, status: "not-installed" };
      }
      if (pluginApiIssue(entry.manifest))
        return { ...base, status: "incompatible", entry };
      // The type's own plugin always suits it.
      if (!base.providesType && !pluginAppliesTo(entry.manifest.appliesTo, read.file.type))
        return { ...base, status: "not-applicable", entry };
      const plugin = grants.plugin(id);
      const requested = capabilityGrants(entry.manifest);
      if (!plugin)
        return { ...base, status: "needs-consent", entry, missing: requested };
      if (!plugin.enabled) return { ...base, status: "disabled", entry };
      const unconsented = missingGrants(requested, plugin.allowed);
      if (unconsented.length)
        return {
          ...base,
          status: "needs-consent",
          entry,
          missing: unconsented,
        };
      const approval = grants.project(key, id);
      const unapproved = approval
        ? missingGrants(requested, approval.allowed)
        : requested;
      if (!approval || unapproved.length)
        return {
          ...base,
          status: "needs-approval",
          entry,
          missing: unapproved,
        };
      return { ...base, status: "active", entry };
    });
  const typeReady =
    !owner ||
    plugins.some(
      (plugin) =>
        plugin.providesType &&
        plugin.status === "active" &&
        plugin.entry?.manifest.contributes?.projectTypes?.some(
          (type) => `${plugin.id}:${type.id}` === read.file.type,
        ),
    );
  return { ok: true, file: read.file, typeReady, plugins };
}

/** Skills agents get in a project: those of its active plugins. */
export function projectSkills(
  resolved: Extract<ProjectPlugins, { ok: true }>,
): Array<PluginSkillSummary & { plugin: string; root: string }> {
  return resolved.plugins.flatMap((plugin) =>
    plugin.status === "active" && plugin.entry
      ? plugin.entry.skills.map((skill) => ({
          ...skill,
          plugin: plugin.id,
          root: plugin.entry!.root,
        }))
      : [],
  );
}

/**
 * Starts a project's plugin file. The person chose the type and plugins
 * while creating it, so they are allowed in this folder at once.
 */
export async function createProjectPlugins({
  folder,
  type,
  plugins,
  index,
  grants,
}: {
  folder: string;
  type: string;
  plugins: Record<string, string>;
  index: PluginIndex;
  grants: PluginGrants;
}): Promise<ProjectFile> {
  for (const [id, version] of Object.entries(plugins))
    if (!index.get(id, version))
      throw new Error(`${id}@${version} is not installed`);
  // One real path for the write and the approvals, so a link changed in
  // between can't move the approvals to another folder.
  await mkdir(folder, { recursive: true });
  const key = await projectFolderKey(folder);
  const file = await writeProjectFileAt(
    key,
    (current) => ({ ...current, type, plugins }),
    { type, plugins },
  );
  for (const [id, version] of Object.entries(plugins))
    await grants.approve(
      key,
      id,
      capabilityGrants(index.get(id, version)!.manifest),
    );
  return file;
}

/**
 * Turns a plugin on in a project at a version, or off with `null`. Turning
 * one on is the person's choice, so it is allowed in this folder too.
 */
export async function setProjectPlugin({
  folder,
  id,
  version,
  index,
  grants,
  initialType,
}: {
  folder: string;
  id: string;
  version: string | null;
  index: PluginIndex;
  grants: PluginGrants;
  /** The type to write when the folder has no `ohmygame.json` yet. */
  initialType?: string;
}): Promise<ProjectFile> {
  const key = await projectFolderKey(folder);
  if (version === null) {
    const file = await writeProjectFileAt(key, (current) => {
      if (projectTypePlugin(current.type) === id)
        throw new Error(
          `${id} provides the project's type and can't be turned off`,
        );
      const { [id]: _removed, ...rest } = current.plugins ?? {};
      return { ...current, plugins: rest };
    });
    await grants.revoke(key, id);
    return file;
  }
  const entry = index.get(id, version);
  if (!entry) throw new Error(`${id}@${version} is not installed`);
  const file = await writeProjectFileAt(key, (current) => {
    if (projectTypePlugin(current.type) !== id && !pluginAppliesTo(entry.manifest.appliesTo, current.type))
      throw new Error(`${id} doesn't work in ${current.type} projects`);
    return { ...current, plugins: { ...current.plugins, [id]: version } };
  }, initialType ? { type: initialType } : undefined);
  await grants.approve(key, id, capabilityGrants(entry.manifest));
  return file;
}
