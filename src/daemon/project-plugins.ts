import type { ProjectPluginPackages } from "./project-plugin-index.js";
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
// A project follows the installed version. Its file overrides the person's
// defaults for which plugins are on, while capability approvals are local to
// the installation and checked against the package that actually runs.

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
  const { $schema: _schema, ...rest } = checked.file;
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
  manifest: Pick<PluginManifestV2, "capabilities" | "ui">,
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
  if (capabilities.sessions) grants.add("sessions");
  if (capabilities.models) grants.add("models");
  if (capabilities.media) grants.add("media");
  if (capabilities.library) grants.add("library");
  if (capabilities.secrets) grants.add("secrets");
  for (const host of capabilities.network ?? []) grants.add(`network:${host}`);
  for (const command of capabilities.processes ?? [])
    grants.add(`process:${command}`);
  // Its pages run code from these folders of the project, which it or the agent may write.
  if (capabilities["project.files"])
    for (const folder of manifest.ui?.projectModules ?? []) {
      const path = folder.replace(/^\.\//, "").replace(/\/+$/, "");
      if (path) grants.add(`modules:${path}`);
    }
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

/**
 * Whether a new version of an installed plugin may replace it without asking:
 * it runs no code of its own outside the app's sandboxes (no native code and
 * no processes, which include MCP servers it starts), asks for nothing the
 * person hasn't allowed, and its chat model providers are the same as the
 * installed version's (`previous`), since where a provider sends prompts and
 * its key isn't a capability, as are the tools it offers agents. Others wait
 * for the person to update them.
 */
export function updatesWithoutAsking(
  manifest: Pick<PluginManifestV2, "capabilities" | "entrypoints" | "contributes">,
  allowed: readonly string[],
  previous?: Pick<PluginManifestV2, "contributes">,
): boolean {
  return (
    !manifest.entrypoints?.native &&
    !manifest.capabilities?.native &&
    !manifest.capabilities?.processes?.length &&
    !missingGrants(capabilityGrants(manifest), allowed).length &&
    chatEndpoints(manifest) === chatEndpoints(previous) &&
    agentTools(manifest) === agentTools(previous)
  );
}

/**
 * The tools a plugin offers agents, which a panel's page can answer without
 * native code: what the agent is told and what answers it. An update that
 * changes them asks first, as the person never saw what the new ones do.
 */
function agentTools(manifest: Pick<PluginManifestV2, "contributes"> | undefined): string {
  return JSON.stringify((manifest?.contributes?.tools ?? [])
    .map((tool) => [tool.name, tool.description, tool.input, tool.output ?? null, tool.panel ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

/**
 * Where a plugin's chat model providers send prompts, and with which key:
 * the parts of a provider that no capability covers. Models, titles and
 * media, which network grants cover, can change.
 */
function chatEndpoints(manifest: Pick<PluginManifestV2, "contributes"> | undefined): string {
  return JSON.stringify((manifest?.contributes?.providers ?? [])
    .filter((provider) => provider.baseUrl !== undefined)
    .map((provider) => [provider.id, provider.api ?? null, provider.baseUrl, provider.apiKey ?? null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

// --- What the person allowed -----------------------------------------------

/** The person's decisions about one plugin. */
export interface PluginGrant {
  /** Off, it runs nowhere, whatever projects say; only safe mode turns it off now. */
  enabled: boolean;
  /** The capabilities allowed for it. */
  allowed: string[];
  /** On in every project it suits; unset, its default (`onInEveryProject`). */
  everyProject?: boolean;
}

/**
 * 3: a plugin a project's file turns on runs once the person consented to it
 * when adding it; nothing is allowed per folder. Version 2 kept those
 * approvals in `projects`; version 1 also kept a separate consent and
 * `enabled: false`.
 */
const GRANTS_SCHEMA = 3;

interface GrantsFile {
  schema: number;
  plugins: Record<string, PluginGrant>;
}

/**
 * The person's plugin decisions: install consent and app switches. The
 * daemon owns the file through one instance; each change still starts from
 * what is on disk, so a second writer can't bring back a decision the first
 * one took away.
 */
export class PluginGrants {
  #data: GrantsFile = { schema: GRANTS_SCHEMA, plugins: {} };
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
      // What a newer app keeps here is written back as it was.
      ...value,
      // A file from before versions were kept is version 1; a new one is current.
      schema: typeof value?.schema === "number" ? value.schema : text === undefined ? GRANTS_SCHEMA : 1,
      plugins: value?.plugins ?? {},
    };
  }

  /**
   * Brings decisions an older app saved up to date, once. `installed` is what
   * each installed plugin asks for, which version 1 left waiting for consent.
   * A file from a newer app is left as it is.
   */
  upgrade(installed: ReadonlyMap<string, readonly string[]>): Promise<void> {
    if (this.#data.schema >= GRANTS_SCHEMA) return Promise.resolve();
    return this.#change((data) => {
      if (data.schema >= GRANTS_SCHEMA) return;
      // compat: since beta.5.6, remove from beta.7 and 2027-01-12. Version 1 grants: separate consent, and plugins stopped everywhere.
      if (data.schema < 2) {
        // Stopped everywhere becomes off everywhere, and allowed nothing new, so a project that turns it on asks.
        const stopped = new Set(Object.entries(data.plugins).flatMap(([id, grant]) => grant.enabled === false ? [id] : []));
        for (const id of stopped) Object.assign(data.plugins[id]!, { enabled: true, everyProject: false });
        for (const [id, asks] of installed) {
          if (stopped.has(id)) continue;
          const current = data.plugins[id] ?? { enabled: true, allowed: [] };
          data.plugins[id] = { ...current, allowed: [...new Set([...current.allowed, ...asks.filter((ask) => ask !== "sessions")])].sort() };
        }
      }
      // compat: since beta.5.11, remove from beta.7 and 2026-12-30. Version 2's per-folder approvals are gone.
      delete (data as { projects?: unknown }).projects;
      data.schema = GRANTS_SCHEMA;
    });
  }

  plugin(id: string): PluginGrant | undefined {
    const grant = this.#data.plugins[id];
    return this.#safeMode ? { ...grant, allowed: grant?.allowed ?? [], enabled: false } : grant;
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

  /** Forgets a plugin everywhere, as when it is uninstalled. */
  forget(id: string): Promise<void> {
    return this.#change((data) => {
      delete data.plugins[id];
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

/** A project folder is known by its real path, so a link or `..` doesn't make it two. */
export async function projectFolderKey(folder: string): Promise<string> {
  return realpath(path.resolve(folder));
}

// --- Resolving a project ---------------------------------------------------

export type ProjectPluginStatus =
  /** On in this project. */
  | "active"
  /** Asked for, but not installed. */
  | "not-installed"
  /** Needs a newer or older OhMyGame plugin API. */
  | "incompatible"
  /** Turned off for the whole app. */
  | "disabled"
  /** Its `appliesTo` leaves out the project's type. */
  | "not-applicable"
  /** This version wants capabilities the person hasn't allowed. */
  | "needs-consent"
  /** A plugin the project carries, turned off in its `ohmygame.json`. */
  | "off"
  /** A folder in the project's `.ohmygame/plugins/` that isn't a plugin the app can use; see `issues`. */
  | "invalid";

export interface ProjectPluginState {
  id: string;
  version: string;
  status: ProjectPluginStatus;
  /** True for the plugin that provides the project's type. */
  providesType: boolean;
  /** On because the person turned it on for every project, not because the project names it. */
  everyProject: boolean;
  /** On, or asking to be, because the folder has one of its `activation.files`. */
  detected?: true;
  entry?: PluginIndexEntry;
  /** Grants still to allow, for `needs-consent`. */
  missing?: string[];
  /** What is wrong with it, for `invalid`. */
  issues?: string[];
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
  /** Whether a folder (its real path) has any of a plugin's `activation.files`. */
  folderHas?: (folder: string, files: readonly string[]) => Promise<boolean>;
  /** The plugins the project in a folder (its real path) carries, once it may run them. */
  copies?: (folder: string) => Promise<ProjectPluginPackages>;
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
  // A plugin that says where it's on is on per project until the person decides.
  return Boolean(newest && !newest.manifest.activation && isAppWidePlugin(newest.manifest) && !scope.startsOff?.has(id));
}

/** Whether a plugin suits a project: the type's own plugin always does. */
export function projectPluginSuits(entry: PluginIndexEntry, kind: ProjectKind, type: string | undefined): boolean {
  if (type && entry.id === projectTypePlugin(type))
    return Boolean(entry.manifest.contributes?.projectTypes?.some((item) => `${entry.id}:${item.id}` === type));
  return appWidePluginSuits(entry.manifest.appliesTo, kind);
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
  // A plugin the project carries replaces the installed one with its id, whole:
  // on unless the file turns it off, at its own version, with nothing to allow.
  const copies = await scope.copies?.(key) ?? { entries: [], problems: [] };
  const carried = new Set([...copies.entries, ...copies.problems].map((item) => item.id));
  const own = [
    ...copies.entries.map((entry): ProjectPluginState => {
      const base = { id: entry.id, version: entry.version, providesType: entry.id === owner, everyProject: false, entry };
      if (off.has(entry.id)) return { ...base, status: "off" };
      if (grants.plugin(entry.id)?.enabled === false) return { ...base, status: "disabled" };
      if (pluginApiIssue(entry.manifest)) return { ...base, status: "incompatible" };
      if (!projectPluginSuits(entry, kind, file?.type)) return { ...base, status: "not-applicable" };
      return { ...base, status: "active" };
    }),
    ...copies.problems.map(({ id, issues }): ProjectPluginState => ({
      id, version: "", providesType: id === owner, everyProject: false, status: "invalid",
      issues: issues.map((issue) => issue.path ? `${issue.path}: ${issue.message}` : issue.message),
    })),
  ];
  const asked = named.flatMap(([id, value]) => value === false || carried.has(id) ? [] : [id]);
  const askedIds = new Set([...asked, ...carried]);

  const listed = asked.map((id): ProjectPluginState => {
    const entry = index.get(id);
    const base = { id, version: entry?.version ?? "", providesType: id === owner, everyProject: false };
    if (!entry) return { ...base, status: "not-installed" };
    if (pluginApiIssue(entry.manifest))
      return { ...base, status: "incompatible", entry };
    if (!projectPluginSuits(entry, kind, file?.type))
      return { ...base, status: "not-applicable", entry };
    const plugin = grants.plugin(id);
    if (plugin?.enabled === false) return { ...base, status: "disabled", entry };
    // One that only adds Skills can't run anything, so it has nothing to allow.
    if (isAppWidePlugin(entry.manifest)) return { ...base, status: "active", entry };
    const requested = capabilityGrants(entry.manifest);
    const unconsented = missingGrants(requested, plugin?.allowed ?? []);
    // Consent was given once, when adding it; a project's file turning it on asks for nothing more.
    if (unconsented.length)
      return { ...base, status: "needs-consent", entry, missing: unconsented };
    return { ...base, status: "active", entry };
  });

  const everywhere = [...new Set(index.entries().map((entry) => entry.id))].flatMap((id): ProjectPluginState[] => {
    if (askedIds.has(id) || off.has(id) || !onInEveryProject(scope, id)) return [];
    const entry = index.get(id);
    const plugin = grants.plugin(id);
    if (!entry || pluginApiIssue(entry.manifest) || plugin?.enabled === false || !projectPluginSuits(entry, kind, file?.type)) return [];
    const base = { id, version: entry.version, providesType: id === owner, everyProject: true, entry };
    const unconsented = missingGrants(capabilityGrants(entry.manifest), plugin?.allowed ?? []);
    return [unconsented.length ? { ...base, status: "needs-consent", missing: unconsented } : { ...base, status: "active" }];
  });

  // On by itself where the folder looks like its kind of project, until the person turns it off there.
  const shown = new Set([...askedIds, ...everywhere.map((plugin) => plugin.id)]);
  const detected = (await Promise.all([...new Set(index.entries().map((entry) => entry.id))].map(async (id): Promise<ProjectPluginState | undefined> => {
    const entry = index.get(id);
    const activation = entry?.manifest.activation;
    if (!entry || shown.has(id) || off.has(id) || typeof activation !== "object" || grants.plugin(id)?.everyProject !== undefined) return undefined;
    if (pluginApiIssue(entry.manifest) || grants.plugin(id)?.enabled === false || !projectPluginSuits(entry, kind, file?.type)) return undefined;
    if (!(await scope.folderHas?.(key, activation.files))) return undefined;
    const base = { id, version: entry.version, providesType: id === owner, everyProject: false, detected: true as const, entry };
    const requested = capabilityGrants(entry.manifest);
    // Asking for nothing, as Skills and prompt commands don't, it has nothing to allow.
    if (isAppWidePlugin(entry.manifest) || !requested.length) return { ...base, status: "active" };
    const unconsented = missingGrants(requested, grants.plugin(id)?.allowed ?? []);
    return unconsented.length ? { ...base, status: "needs-consent", missing: unconsented } : { ...base, status: "active" };
  }))).filter((plugin) => plugin !== undefined);

  const plugins = [...own, ...listed, ...everywhere, ...detected].sort((a, b) =>
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
 * while creating it, which consents to what they ask for.
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
  const selected = Object.entries(plugins).map(([id, version]) => {
    const entry = index.get(id, version);
    if (!entry) throw new Error(`${id}@${version} is not installed`);
    return entry;
  });
  await mkdir(folder, { recursive: true });
  const key = await projectFolderKey(folder);
  const enabled = Object.fromEntries(Object.keys(plugins).map((id) => [id, true]));
  const file = await writeProjectFileAt(
    key,
    (current) => ({ ...current, type, plugins: enabled }),
    { type, plugins: enabled },
  );
  // Choosing a plugin is turning it on, which allows what it asks for.
  for (const entry of selected) await grants.consent(entry.id, capabilityGrants(entry.manifest));
  return file;
}

/**
 * Turns a plugin on or off in a project, writing only what differs from the
 * person's choice for every project, or from what the folder's files turn on
 * (`activation`): off where it is on anyway is `false`, on where it isn't is
 * `true`, and
 * anything else is no entry. Turning one on consents to what it asks for.
 */
export async function setProjectPlugin({
  folder,
  id,
  on,
  initialType,
  ...scope
}: PluginScope & {
  folder: string;
  id: string;
  on: boolean;
  /** The type to write when the folder has no `ohmygame.json` yet. */
  initialType?: string;
}): Promise<ProjectFile | undefined> {
  const key = await projectFolderKey(folder);
  const everywhere = onInEveryProject(scope, id);
  const exists = Boolean(await readProjectFile(key));
  const initial = initialType ? { type: initialType } : undefined;
  // A plugin the project carries is on unless its file says `false`, and it allows nothing.
  const copies = await scope.copies?.(key);
  if ([...copies?.entries ?? [], ...copies?.problems ?? []].some((item) => item.id === id)) {
    return writeProjectFileAt(key, (current) => {
      if (!on && projectTypePlugin(current.type) === id)
        throw new Error(`${id} provides the project's type and can't be turned off`);
      const { [id]: _previous, ...rest } = current.plugins ?? {};
      return { ...current, plugins: on && projectTypePlugin(current.type) !== id ? rest : { ...rest, [id]: on } };
    }, initial);
  }
  // On by itself here, as `resolveProjectPlugins` detects it, until the file says `false`.
  const current = scope.index.get(id);
  const activation = current?.manifest.activation;
  const detected = !everywhere && typeof activation === "object" && scope.grants.plugin(id)?.everyProject === undefined
    && !pluginApiIssue(current!.manifest) && scope.grants.plugin(id)?.enabled !== false
    && Boolean(await scope.folderHas?.(key, activation.files));
  if (!on) {
    if (!everywhere && !detected && !exists) return undefined;
    const file = await writeProjectFileAt(key, (current) => {
      if (projectTypePlugin(current.type) === id)
        throw new Error(`${id} provides the project's type and can't be turned off`);
      const { [id]: _removed, ...rest } = current.plugins ?? {};
      return { ...current, plugins: everywhere || detected ? { ...rest, [id]: false } : rest };
    }, initial);
    return file;
  }
  const read = await readProjectFile(key);
  const file = read?.ok ? read.file : undefined;
  const kind = await kindOf(scope, key, file);
  const entry = scope.index.get(id);
  if (!entry) throw new Error(`${id} is not installed`);
  const apiIssue = pluginApiIssue(entry.manifest);
  if (apiIssue) throw new Error(apiIssue.message);
  if (!projectPluginSuits(entry, kind, file?.type))
    throw new Error(`${id} doesn't work in ${kind.pluginType?.id ?? kind.type} projects`);
  await scope.grants.consent(id, capabilityGrants(entry.manifest));
  // The plugin that supplies the project type is always an explicit dependency.
  const follows = (everywhere || detected) && projectTypePlugin(file?.type ?? "") !== id;
  if (follows && !exists) return undefined;
  if (follows && file && !Object.hasOwn(file.plugins ?? {}, id)) return file;
  return writeProjectFileAt(key, (current) => {
    const { [id]: _previous, ...rest } = current.plugins ?? {};
    return { ...current, plugins: follows ? rest : { ...rest, [id]: true } };
  }, initial);
}
