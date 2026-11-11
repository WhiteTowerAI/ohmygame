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
import { isAppWidePlugin, pluginApiIssue } from "../shared/plugin-manifest.js";
import { appWidePluginSuits } from "../shared/project-runtime.js";
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
// Every plugin is on or off in each project. A plugin the person turned on
// for every project is on in each one it suits, at its newest version, unless
// the project's `ohmygame.json` turns it off (`false`); any other plugin is on
// where `ohmygame.json` names it, at a version or, for one that asks for
// nothing, at its newest (`true`). The file holds only what differs from the
// person's choice for every project.
//
// What a plugin asks for is allowed once per plugin (its capabilities, shown
// when it is turned on) and, when a project's own file names it, once more for
// that project folder, since the file can come from someone else. Both are
// kept in the person's data, never in the project, and both are asked again
// when a version wants more than was allowed.

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
  // The schema URL is the current one, also over one an older OhMyGame wrote.
  const { $schema: _schema, ...rest } = next;
  const ordered = { $schema: PROJECT_FILE_SCHEMA_URL, ...rest };
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
  if (capabilities["project.history"]) grants.add("project.history");
  if (capabilities["project.usage"]) grants.add("project.usage");
  if (capabilities.agent) grants.add("agent");
  if (capabilities.game) grants.add("game");
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

/** The person's decisions about one plugin. */
export interface PluginGrant {
  /** Off, it runs nowhere, whatever projects say. */
  enabled: boolean;
  /** The capabilities allowed for it. */
  allowed: string[];
  /** On in every project it suits; unset, its default (`onInEveryProject`). */
  everyProject?: boolean;
}

interface GrantsFile {
  schema: 1;
  plugins: Record<string, PluginGrant>;
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
  readonly #safeMode: boolean;

  /** In safe mode every plugin reads as off; what is saved doesn't change. */
  constructor(private readonly file: string, options: { safeMode?: boolean } = {}) {
    this.#safeMode = options.safeMode ?? false;
  }

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

  plugin(id: string): PluginGrant | undefined {
    const grant = this.#data.plugins[id];
    return this.#safeMode ? { ...grant, allowed: grant?.allowed ?? [], enabled: false } : grant;
  }

  project(folderKey: string, id: string) {
    return this.#data.projects[folderKey]?.[id];
  }

  /** Records consent for a plugin's capabilities; a new plugin starts on. */
  consent(id: string, allowed: readonly string[]): Promise<void> {
    return this.#change((data) => {
      const current = data.plugins[id];
      data.plugins[id] = {
        ...current,
        enabled: current?.enabled ?? true,
        allowed: [...new Set([...(current?.allowed ?? []), ...allowed])].sort(),
      };
    });
  }

  /** Turns a plugin on or off for every project it suits. */
  setEveryProject(id: string, on: boolean): Promise<void> {
    return this.#change((data) => {
      data.plugins[id] = { ...(data.plugins[id] ?? { enabled: true, allowed: [] }), everyProject: on };
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
  /** This version wants capabilities the person hasn't allowed. */
  | "needs-consent"
  /** Not yet allowed in this project folder, or this version wants more. */
  | "needs-approval";

export interface ProjectPluginState {
  id: string;
  version: string;
  status: ProjectPluginStatus;
  /** True for the plugin that provides the project's type. */
  providesType: boolean;
  /** On because the person turned it on for every project, not because the project names it. */
  everyProject: boolean;
  entry?: PluginIndexEntry;
  /** Grants still to allow, for the two consent states. */
  missing?: string[];
  /** Installed versions, for `version-not-installed`. */
  installed?: string[];
}

export type ProjectPlugins =
  | {
      ok: true;
      /** Undefined while the folder has no `ohmygame.json`. */
      file?: ProjectFile;
      /** Whether the type's plugin is active; when not, the project opens with placeholders. */
      typeReady: boolean;
      plugins: ProjectPluginState[];
    }
  | { ok: false; issues: string[] };

/** What a project is, for matching `appliesTo`: its kind in the app and, for a plugin type, that type. */
export type ProjectKind = { type: string; pluginType?: { id: string } | undefined };

/** What deciding which plugins are on needs: the installed plugins and the person's decisions. */
export interface PluginScope {
  index: PluginIndex;
  grants: PluginGrants;
  /** Plugins that ask for nothing yet start off in every project, such as bundled ones in beta. */
  startsOff?: ReadonlySet<string>;
  /** What the project in a folder (its real path) is; unknown, the type its `ohmygame.json` says. */
  kind?: (folder: string) => ProjectKind | undefined | Promise<ProjectKind | undefined>;
}

/**
 * Whether a plugin is on in every project it suits: as the person set it,
 * else on when its newest version asks for nothing (only adds Skills) and it
 * doesn't start off.
 */
export function onInEveryProject(scope: Pick<PluginScope, "index" | "grants" | "startsOff">, id: string): boolean {
  const decided = scope.grants.plugin(id)?.everyProject;
  if (decided !== undefined) return decided;
  const newest = scope.index.get(id);
  return Boolean(newest && isAppWidePlugin(newest.manifest) && !scope.startsOff?.has(id));
}

/** Whether a plugin suits a project: the type's own plugin always does. */
function suits(entry: PluginIndexEntry, kind: ProjectKind, owner: string | undefined): boolean {
  return entry.id === owner || appWidePluginSuits(entry.manifest.appliesTo, kind);
}

/** The project's kind, from the app when it knows the folder, else from its file. */
async function kindOf(scope: PluginScope, key: string, file: ProjectFile | undefined): Promise<ProjectKind> {
  const known = await scope.kind?.(key);
  if (known) return known;
  const type = file?.type ?? "general";
  return projectTypePlugin(type) ? { type, pluginType: { id: type } } : { type };
}

/** Every plugin on in a project, or that its file asks for, with whether it runs and, if not, why. */
export async function resolveProjectPlugins({
  folder,
  ...scope
}: PluginScope & { folder: string }): Promise<ProjectPlugins> {
  const key = await projectFolderKey(folder);
  const read = await readProjectFile(key);
  if (read && !read.ok) return read;
  const file = read?.file;
  const kind = await kindOf(scope, key, file);
  const owner = file ? projectTypePlugin(file.type) : undefined;
  const { index, grants } = scope;
  const named = Object.entries(file?.plugins ?? {});
  const off = new Set(named.flatMap(([id, value]) => value === false ? [id] : []));
  const asked = named.flatMap(([id, value]) => value === false ? [] : [[id, value] as const]);
  const askedIds = new Set(asked.map(([id]) => id));

  const listed = asked.map(([id, value]): ProjectPluginState => {
    const base = { id, version: typeof value === "string" ? value : index.get(id)?.version ?? "", providesType: id === owner, everyProject: false };
    const entry = typeof value === "string" ? index.get(id, value) : index.get(id);
    if (!entry) {
      const installed = index.versions(id).map((item) => item.version);
      return installed.length
        ? { ...base, status: "version-not-installed", installed }
        : { ...base, status: "not-installed" };
    }
    if (pluginApiIssue(entry.manifest))
      return { ...base, status: "incompatible", entry };
    if (!suits(entry, kind, owner))
      return { ...base, status: "not-applicable", entry };
    const plugin = grants.plugin(id);
    if (plugin?.enabled === false) return { ...base, status: "disabled", entry };
    // One that only adds Skills can't run anything, so it has nothing to allow.
    if (isAppWidePlugin(entry.manifest)) return { ...base, status: "active", entry };
    const requested = capabilityGrants(entry.manifest);
    const unconsented = missingGrants(requested, plugin?.allowed ?? []);
    if (unconsented.length)
      return { ...base, status: "needs-consent", entry, missing: unconsented };
    // The file may come from someone else, so the person allows it in this folder too.
    const approval = grants.project(key, id);
    const unapproved = approval ? missingGrants(requested, approval.allowed) : requested;
    if (!approval || unapproved.length)
      return { ...base, status: "needs-approval", entry, missing: unapproved };
    return { ...base, status: "active", entry };
  });

  // The person's own choice for every project needs no approval per folder.
  const everywhere = [...new Set(index.entries().map((entry) => entry.id))].flatMap((id): ProjectPluginState[] => {
    if (askedIds.has(id) || off.has(id) || !onInEveryProject(scope, id)) return [];
    const entry = index.get(id);
    const plugin = grants.plugin(id);
    if (!entry || pluginApiIssue(entry.manifest) || plugin?.enabled === false || !suits(entry, kind, owner)) return [];
    const base = { id, version: entry.version, providesType: id === owner, everyProject: true, entry };
    const unconsented = missingGrants(capabilityGrants(entry.manifest), plugin?.allowed ?? []);
    return [unconsented.length ? { ...base, status: "needs-consent", missing: unconsented } : { ...base, status: "active" }];
  });

  const plugins = [...listed, ...everywhere].sort((a, b) =>
    a.id === owner ? -1 : b.id === owner ? 1 : a.id.localeCompare(b.id),
  );
  const typeReady =
    !owner ||
    plugins.some(
      (plugin) =>
        plugin.providesType &&
        plugin.status === "active" &&
        plugin.entry?.manifest.contributes?.projectTypes?.some(
          (type) => `${plugin.id}:${type.id}` === file!.type,
        ),
    );
  return { ok: true, ...(file ? { file } : {}), typeReady, plugins };
}

/** Skills agents get in a project: those of its active plugins, in the order resolved. */
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
 * Turns a plugin on or off in a project, writing only what differs from the
 * person's choice for every project: off where it is on everywhere is
 * `false`, on where it isn't is the version (`true`, the newest, for one that
 * asks for nothing), and anything else is no entry. Turning one on is the
 * person's choice, so it is allowed in this folder too.
 */
export async function setProjectPlugin({
  folder,
  id,
  on,
  version,
  initialType,
  ...scope
}: PluginScope & {
  folder: string;
  id: string;
  on: boolean;
  /** An installed version to move the project to; when absent, the newest that works in the project. */
  version?: string;
  /** The type to write when the folder has no `ohmygame.json` yet. */
  initialType?: string;
}): Promise<ProjectFile | undefined> {
  const key = await projectFolderKey(folder);
  const everywhere = onInEveryProject(scope, id);
  const exists = Boolean(await readProjectFile(key));
  const initial = initialType ? { type: initialType } : undefined;
  if (!on) {
    if (!everywhere && !exists) return undefined;
    const file = await writeProjectFileAt(key, (current) => {
      if (projectTypePlugin(current.type) === id)
        throw new Error(`${id} provides the project's type and can't be turned off`);
      const { [id]: _removed, ...rest } = current.plugins ?? {};
      return { ...current, plugins: everywhere ? { ...rest, [id]: false } : rest };
    }, initial);
    await scope.grants.revoke(key, id);
    return file;
  }
  const newest = scope.index.get(id);
  const read = await readProjectFile(key);
  const kind = await kindOf(scope, key, read?.ok ? read.file : undefined);
  const owner = read?.ok ? projectTypePlugin(read.file.type) : undefined;
  // An older version can be the newest that works here, when a later one dropped the project's kind.
  const entry = version ? scope.index.get(id, version)
    : scope.index.versions(id).find((item) => !pluginApiIssue(item.manifest) && suits(item, kind, owner)) ?? newest;
  if (!entry) throw new Error(`${id}${version ? `@${version}` : ""} is not installed`);
  if (!suits(entry, kind, owner))
    throw new Error(`${id} doesn't work in ${kind.pluginType?.id ?? kind.type} projects`);
  // On everywhere at its newest: the project follows that and names nothing.
  const follows = everywhere && entry === newest && owner !== id;
  if (follows && !exists) return undefined;
  const value = follows ? undefined : entry === newest && !version && isAppWidePlugin(entry.manifest) ? true : entry.version;
  const file = await writeProjectFileAt(key, (current) => {
    const { [id]: _previous, ...rest } = current.plugins ?? {};
    return { ...current, plugins: value === undefined ? rest : { ...rest, [id]: value } };
  }, initial);
  if (value !== undefined) await scope.grants.approve(key, id, capabilityGrants(entry.manifest));
  return file;
}
