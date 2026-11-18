import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import {
  DRAFT_PLAYGROUND,
  draftPlugin,
  NEW_PLUGIN_TITLE,
  type PluginSetupSummary,
  type PluginDraft,
  type DraftCapture,
  type PluginDraftRun,
  type PluginIconUpdate,
  type PluginSetupMode,
} from "../shared/plugin-setup.js";
import type { ProjectState, RuntimeEventData } from "../shared/contracts.js";
import type { McpServerDefinition, PluginMcpResult } from "../shared/plugins.js";
import { sessionDirectory } from "./conversations.js";
import type { PluginMcpHost } from "./plugin-mcp-host.js";
import { entryPanels, type DraftRunTarget, type PluginServices, type ProjectPanel } from "./plugin-services.js";
import { panelPluginId, panelPluginPrompt, writePanelPlugin } from "./panel-to-plugin.js";
import type { ProjectPanelManifest } from "../shared/project-panels.js";
import { draftRunKey, draftUpdate, inspectPluginDraft, inspectPluginFiles, pluginDraftPath, readPluginDraftFile } from "./plugin-draft.js";
import { isPluginIcon, PLUGIN_MANIFEST_PATH } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { indexPluginPackage, localizePluginString, type PluginIndexEntry, type PluginLocale } from "./plugin-index.js";
import { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MEDIA_TYPES } from "../shared/plugin-icons.js";
import { readPluginIconAsset, validatePluginIconImage } from "./plugin-icons.js";

/** What's kept of a workspace; its conversations are its project's. */
type SetupRuntimeState = Pick<PluginSetupSummary, "id" | "mode" | "pluginId" | "title" | "createdAt" | "updatedAt"> & {
  projectId: string;
  /** Held while an icon change, a test or an install runs. */
  busy: boolean;
  draftPath?: string;
  installedRevision?: string;
  baseRevision?: string;
  checks?: PluginDraft["checks"];
  /** What the draft asked for when the person allowed its code to run here; see `draftRunKey`. */
  runAllowed?: string;
};

/**
 * A workspace's draft as it runs in the workspace itself: under its own
 * plugin id, with the workspace's playground as its project's files.
 */
export interface DraftRuntime {
  setupId: string;
  /** `_draft/<setupId>`. */
  plugin: string;
  entry: PluginIndexEntry;
  /** The folder its pages and code take as the project's. */
  playground: string;
  /** The person allowed its code to run here, as it asks now. */
  runAllowed: boolean;
}

/** How long a capture request waits for the open workspace to answer. */
const DRAFT_CAPTURE_TIMEOUT_MS = 15_000;

/** How many installed packages' file hashes are kept for comparing drafts with. */
const INSTALLED_HASHES_KEPT = 8;

/** Pages ask often, as each file request checks its panel; a draft read this recently is reused. */
const DRAFT_RUNTIME_REUSE_MS = 1000;

/** The hidden project behind each workspace, which holds its conversations. */
export interface PluginWorkspaceProjects {
  create(name: string | undefined, workspacePath: string): Promise<ProjectState>;
  get(projectId: string): ProjectState | undefined;
  remove(project: ProjectState): Promise<void>;
  busy(projectId: string): boolean;
  /** Runs while the project takes no turns, so the agent can't change what is being installed. */
  exclusive<T>(projectId: string, operation: () => Promise<T>): Promise<T>;
}

export class PluginSetupManager {
  #states = new Map<string, SetupRuntimeState>();
  #loading = new Map<string, Promise<SetupRuntimeState>>();
  #writes = new Map<string, Promise<void>>();
  #runtimes = new Map<string, { at: number; draftPath: string; runtime: Promise<DraftRuntime | undefined> }>();
  /** The draft digest each workspace's host last loaded; another one needs a new host, which imports it afresh. */
  #hostDigests = new Map<string, string>();
  /** The file hashes of the installed package last compared with a draft; see `#installedHashes`. */
  #hashes = new Map<string, Promise<Map<string, string>>>();
  #changed: ((projectId: string) => void) | undefined;
  /** Captures of a draft's panel the agent waits for, by request; see `capture`. */
  #captures = new Map<string, { setupId: string; resolve: (image: DraftCapture) => void; reject: (error: Error) => void }>();
  #publishCapture: ((projectId: string, data: RuntimeEventData["plugin.draft.capture"]) => void) | undefined;
  /** Each workspace's latest run, which the next one waits for. */
  #runs = new Map<string, Promise<unknown>>();
  #installs: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly dataDirectory: string,
    private readonly agentDirectory: string,
    private readonly host: PluginMcpHost,
    private readonly services: PluginServices,
    private readonly invalidate: () => void,
    private readonly projects: PluginWorkspaceProjects,
  ) {}
  #directory(id: string): string {
    return path.join(this.dataDirectory, "plugin-setup", id);
  }
  #workspace(id: string): string {
    return path.join(this.#directory(id), "workspace");
  }
  async create(pluginId?: string, mode: PluginSetupMode = pluginId ? "edit" : "create"): Promise<PluginSetupSummary> {
    if (mode === "create" && pluginId) throw new Error("Create a new plugin without an installed target");
    await this.services.ready();
    const editing = mode === "edit" && pluginId ? this.services.index.get(pluginId) : undefined;
    if (mode === "edit" && !editing) throw new Error("Select an installed plugin");
    if (editing && !editing.id.startsWith(`${PERSONAL_PUBLISHER}/`)) throw new Error("Only a plugin you made can be edited");
    const id = randomUUID();
    const title = editing ? localizePluginString(editing, editing.manifest.displayName, "en") : NEW_PLUGIN_TITLE;
    const workspace = this.#workspace(id);
    await mkdir(workspace, { recursive: true });
    let project: ProjectState | undefined;
    try {
      project = await this.projects.create(editing ? title : undefined, workspace);
      const state: SetupRuntimeState = { id, mode, pluginId, projectId: project.id, busy: false, title, createdAt: Date.now(), updatedAt: Date.now() };
      if (editing) {
        const name = editing.id.slice(editing.id.indexOf("/") + 1);
        const root = path.join(workspace, name);
        await cp(editing.root, root, { recursive: true, verbatimSymlinks: true });
        state.baseRevision = editing.digest;
        state.draftPath = name;
        state.installedRevision = (await inspectPluginFiles(root)).revision;
      }
      this.#states.set(id, state);
      await this.#save(state);
    } catch (cause) {
      if (project) await this.projects.remove(project);
      await rm(this.#directory(id), { recursive: true, force: true });
      throw cause;
    }
    return this.read(id);
  }
  /**
   * A new workspace whose draft is a project's own panel made into a plugin
   * (`writePanelPlugin`), checked as the agent would check it. `prompt` is
   * what the person sends its agent to finish it.
   */
  async createFromPanel(panelFolder: string, name: string, panel: ProjectPanelManifest): Promise<{ summary: PluginSetupSummary; prompt: string }> {
    await this.services.ready();
    // Free means no plugin is installed with it, and no other workspace's draft would install one.
    const drafted = new Set((await Promise.all((await this.#all()).map(state => this.#draftId(state)))).filter(Boolean));
    const id = panelPluginId(name, taken => this.services.index.versions(taken).length > 0 || drafted.has(taken));
    const folder = id.slice(id.indexOf("/") + 1);
    const created = await this.create();
    try {
      await writePanelPlugin(path.join(this.#workspace(created.id), folder), panelFolder, id, name, panel);
      await this.prepare(created.id, folder);
    } catch (cause) {
      await this.remove(created.id).catch(() => {});
      throw cause;
    }
    return { summary: await this.read(created.id), prompt: panelPluginPrompt(folder, panel) };
  }
  async read(id: string): Promise<PluginSetupSummary> {
    return this.#summary(await this.#loadState(id));
  }
  #loadState(id: string): Promise<SetupRuntimeState> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.reject(new Error("Invalid plugin setup session"));
    const loaded = this.#states.get(id);
    const state = loaded ? Promise.resolve(loaded) : this.#loading.get(id) ?? this.#load(id);
    return state.then(state => this.#forgetUninstalled(state));
  }
  /** One read at a time, so readers share a state and a workspace gets one project. */
  #load(id: string): Promise<SetupRuntimeState> {
    const loading = (async () => {
      const stored = JSON.parse(await readFile(path.join(this.#directory(id), "state.json"), "utf8")) as Partial<SetupRuntimeState>;
      // Sessions that configured an older kind of plugin have nothing to work on now.
      if ((stored.mode as string | undefined) === "configure" || (!stored.mode && stored.pluginId && !stored.draftPath))
        throw new Error("This plugin assistant session is no longer available");
      const title = stored.title ?? "Plugin workspace";
      const state: SetupRuntimeState = {
        id, title, mode: stored.mode ?? "create", pluginId: stored.pluginId, busy: false,
        projectId: stored.projectId && this.projects.get(stored.projectId) ? stored.projectId : await this.#adopt(id, title),
        createdAt: stored.createdAt ?? Date.now(), updatedAt: stored.updatedAt ?? Date.now(),
        draftPath: stored.draftPath, installedRevision: stored.installedRevision,
        baseRevision: stored.baseRevision, checks: stored.checks, runAllowed: stored.runAllowed,
      };
      if (state.projectId !== stored.projectId) await this.#save(state);
      this.#states.set(id, state);
      return state;
    })().finally(() => this.#loading.delete(id));
    this.#loading.set(id, loading);
    return loading;
  }
  /** A workspace from before they were projects: its project takes over the conversation. */
  async #adopt(id: string, title: string): Promise<string> {
    const workspace = this.#workspace(id);
    await mkdir(workspace, { recursive: true });
    const project = await this.projects.create(title === NEW_PLUGIN_TITLE ? undefined : title, workspace);
    const from = path.join(this.#directory(id), "sessions");
    const files = await readdir(from).catch(() => []);
    const to = sessionDirectory(project);
    await mkdir(to, { recursive: true });
    await Promise.all(files.map(file => rename(path.join(from, file), path.join(to, file))));
    await rm(from, { recursive: true, force: true });
    return project.id;
  }
  async #forgetUninstalled(state: SetupRuntimeState): Promise<SetupRuntimeState> {
    if (state.pluginId && !state.busy) {
      const pluginId = state.pluginId;
      const installed = await this.#installed(state);
      if (!installed && state.pluginId === pluginId && !state.busy) {
        state.pluginId = undefined;
        state.installedRevision = undefined;
        state.baseRevision = undefined;
        state.checks = {};
        state.updatedAt = Date.now();
        await this.#save(state);
      }
    }
    return state;
  }
  async #installed(state: SetupRuntimeState): Promise<boolean> {
    await this.services.ready();
    return this.services.index.versions(state.pluginId!).length > 0;
  }
  async list(): Promise<PluginSetupSummary[]> {
    const summaries = await Promise.all((await this.#all()).map(state => this.#summary(state)));
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async #all(): Promise<SetupRuntimeState[]> {
    const directory = path.join(this.dataDirectory, "plugin-setup");
    const entries = await readdir(directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    const results = await Promise.allSettled(entries.filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => this.#loadState(id)));
    return results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
  }
  async remove(id: string): Promise<void> {
    const state = await this.#loadState(id);
    this.#hold(state, "Wait for the builder to finish before deleting its workspace");
    try {
      await this.#writes.get(id);
      // Its draft's host may be writing in the workspace's folder; it stops before the folder goes.
      await this.services.native.stopScope(draftScope(id)).catch(() => {});
      const project = this.projects.get(state.projectId);
      if (project) await this.projects.remove(project);
      const directory = this.#directory(id);
      const removed = `${directory}.removed-${randomUUID()}`;
      await rename(directory, removed);
      this.#states.delete(id);
      this.#writes.delete(id);
      this.#runtimes.delete(id);
      this.services.logs.forget(draftPlugin(id));
      this.#hostDigests.delete(id);
      await rm(removed, { recursive: true, force: true });
    } finally { state.busy = false; }
  }
  /** Keeps others off the workspace, and waits for its agent to finish. */
  #hold(state: SetupRuntimeState, busy: string): void {
    if (state.busy || this.projects.busy(state.projectId)) throw new Error(busy);
    state.busy = true;
  }
  async #summary(state: SetupRuntimeState): Promise<PluginSetupSummary> {
    const project = this.projects.get(state.projectId);
    // The agent may be midway through writing the manifest; the icon then just waits.
    const icon = await this.#draftIcon(state).catch(() => undefined);
    return {
      id: state.id, projectId: state.projectId, mode: state.mode, pluginId: state.pluginId,
      // Until its draft has a name, a new workspace goes by what its project was named after.
      title: state.title === NEW_PLUGIN_TITLE && project?.nameSource === "ai" ? project.name : state.title,
      ...(icon ? { icon: { type: "asset" as const, path: icon } } : {}),
      createdAt: state.createdAt,
      updatedAt: Math.max(state.updatedAt, project ? Date.parse(project.updatedAt) : 0),
      status: state.busy || this.projects.busy(state.projectId) ? "working"
        : state.pluginId && state.installedRevision ? "installed" : state.draftPath ? "ready" : "idle",
    };
  }
  async draft(id: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    if (!state.draftPath) return { files: [], errors: [] };
    // Undoing the turn that made the draft takes its folder away, and with it the draft.
    const root = await pluginDraftPath(this.#workspace(id), state.draftPath).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (!root) return { files: [], errors: [] };
    const { hashes, ...draft } = await inspectPluginDraft(root, state.installedRevision);
    if (draft.plugin && state.pluginId && draft.plugin.id !== state.pluginId) {
      draft.errors.push(`This draft updates ${state.pluginId}, so it must keep that id`);
      draft.plugin = undefined;
    }
    // An update says what it changes in the installed plugin, which it replaces. What it asks for is
    // always said, so more is never allowed unseen; its files only when the installed package reads.
    const installed = draft.plugin && state.pluginId && draft.revision !== state.installedRevision
      ? (await this.services.ready(), this.services.index.get(state.pluginId)) : undefined;
    const installedHashes = installed && hashes ? await this.#installedHashes(installed).catch(() => undefined) : undefined;
    const update = installed ? draftUpdate(draft.plugin!, installed, installedHashes && hashes ? { draft: hashes, installed: installedHashes } : undefined) : undefined;
    return { ...draft, path: state.draftPath, checks: state.checks, ...(draft.plugin?.native ? { runAllowed: draft.plugin.native.key === state.runAllowed } : {}), ...(update ? { update } : {}) };
  }
  /** The installed package's file hashes, kept by its digest, which changes whenever they do. */
  #installedHashes(entry: PluginIndexEntry): Promise<Map<string, string>> {
    let hashes = this.#hashes.get(entry.digest);
    if (!hashes) {
      hashes = inspectPluginFiles(entry.root).then(result => result.hashes);
      hashes.catch(() => this.#hashes.delete(entry.digest));
      // A few installed packages at a time, as open workspaces compare with theirs.
      if (this.#hashes.size >= INSTALLED_HASHES_KEPT) this.#hashes.delete(this.#hashes.keys().next().value!);
      this.#hashes.set(entry.digest, hashes);
    }
    return hashes;
  }
  async prepare(id: string, requested: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    const workspace = this.#workspace(id);
    const root = await pluginDraftPath(workspace, requested);
    // The draft's path is real, so the workspace's must be too, or a data folder reached through a link names it from outside.
    state.draftPath = path.relative(await realpath(workspace), root) || ".";
    // Its pages load this draft from now on, and what earlier drafts logged is no longer about it.
    this.#runtimes.delete(id);
    this.services.logs.forget(draftPlugin(id));
    // A draft that stopped its host too often may run again once it is handed over afresh.
    this.services.native.release(draftPlugin(id));
    const draft = await this.draft(id);
    if (draft.plugin) state.title = draft.plugin.displayName;
    state.updatedAt = Date.now();
    await this.#save(state);
    return draft;
  }
  async file(id: string, requested: string) {
    const state = await this.#loadState(id);
    if (!state.draftPath) throw new Error("No plugin draft yet");
    const root = await pluginDraftPath(this.#workspace(id), state.draftPath);
    return readPluginDraftFile(root, requested);
  }
  async icon(id: string, requested?: string) {
    const state = await this.#loadState(id);
    if (!state.draftPath) return undefined;
    const root = await pluginDraftPath(this.#workspace(id), state.draftPath);
    const icon = requested ?? await this.#draftIcon(state);
    return readPluginIconAsset(root, icon ? { type: "asset", path: icon } : undefined);
  }
  /** The plugin id the draft's manifest names, as it stands on disk; undefined when it can't be read. */
  async #draftId(state: SetupRuntimeState): Promise<string | undefined> {
    if (!state.draftPath) return undefined;
    try {
      const root = await pluginDraftPath(this.#workspace(state.id), state.draftPath);
      const { id } = JSON.parse((await readPluginDraftFile(root, PLUGIN_MANIFEST_PATH)).content) as { id?: unknown };
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  }
  /** The icon the draft's manifest names, as it stands on disk. */
  async #draftIcon(state: SetupRuntimeState): Promise<string | undefined> {
    if (!state.draftPath) return undefined;
    const root = await pluginDraftPath(this.#workspace(state.id), state.draftPath);
    const { content } = await readPluginDraftFile(root, PLUGIN_MANIFEST_PATH);
    const { icon } = JSON.parse(content) as { icon?: unknown };
    return typeof icon === "string" ? icon : undefined;
  }
  async updateIcon(id: string, input: PluginIconUpdate): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    this.#hold(state, "Wait for the builder to finish before changing its icon");
    try {
      const draft = await this.draft(id);
      if (!draft.plugin || draft.errors.length || !state.draftPath) throw new Error("Prepare a valid draft before changing its icon");
      if (draft.revision !== input.revision) throw new Error("The draft changed. Refresh the preview before changing its icon");
      const root = await pluginDraftPath(this.#workspace(id), state.draftPath);
      let icon = "icon" in input ? input.icon : undefined;
      if ("image" in input) {
        const { data, mediaType } = input.image;
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length > Math.ceil(PLUGIN_ICON_MAX_BYTES / 3) * 4) throw new Error("Choose a PNG, WebP, or static SVG plugin icon up to 1 MB");
        const bytes = Buffer.from(data, "base64");
        if (bytes.toString("base64") !== data) throw new Error("Invalid plugin icon image");
        const image = await validatePluginIconImage(bytes, mediaType);
        const filename = `plugin-icon-${image.revision}.${Object.entries(PLUGIN_ICON_MEDIA_TYPES).find(([, type]) => type === image.mediaType)![0]}`;
        const assets = path.join(root, "assets");
        await mkdir(assets, { recursive: true });
        const target = path.join(assets, filename);
        await writeFile(target, bytes, { flag: "wx" }).catch(async (cause: NodeJS.ErrnoException) => {
          if (cause.code !== "EEXIST") throw cause;
          if (!(await readFile(target)).equals(bytes)) throw new Error("The plugin icon file already exists with different content");
        });
        icon = { type: "asset", path: `./assets/${filename}` };
      }
      if (icon && !isPluginIcon(icon)) throw new Error("Choose a PNG/WebP/SVG path inside the plugin");
      await readPluginIconAsset(root, icon ?? undefined);
      const file = path.join(root, PLUGIN_MANIFEST_PATH);
      const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      if (icon) manifest.icon = icon.path; else delete manifest.icon;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      state.checks = {};
      state.updatedAt = Date.now();
      return await this.draft(id);
    } finally { state.busy = false; await this.#save(state); }
  }
  async testDraft(id: string, server: string, revision: string) {
    const state = await this.#loadState(id);
    this.#hold(state, "Wait for the builder to finish before testing");
    try { return await this.#testDraft(state, server, revision); }
    finally { state.busy = false; await this.#save(state); }
  }
  async #testDraft(state: SetupRuntimeState, server: string, revision?: string) {
    const draft = await this.draft(state.id);
    if (!draft.plugin || draft.errors.length || !state.draftPath || !draft.revision) throw new Error("Prepare a valid draft before testing");
    if (revision !== undefined && draft.revision !== revision) throw new Error("The draft changed. Refresh the preview before testing");
    const root = await pluginDraftPath(this.#workspace(state.id), state.draftPath);
    const { definition, secrets } = await this.services.draftMcpServer(root, server, {
      withSaved: draft.plugin.id === state.pluginId && draft.revision === state.installedRevision,
    });
    const result: PluginMcpResult = definition
      ? await this.#probe(`draft:${state.id}:${server}`, `draft-${state.id}-${server}`, definition, secrets)
      : { status: "failed", toolCount: 0, message: "Install this draft and fill in its settings, then test this server" };
    state.checks = { ...state.checks, [server]: { revision: draft.revision, result } };
    return result;
  }
  /** Tries an MCP server that isn't installed, keeping its secrets out of what comes back. */
  async #probe(key: string, name: string, definition: McpServerDefinition, secrets: readonly string[]): Promise<PluginMcpResult> {
    const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
    try {
      const result = await this.host.probe(key, name, definition, this.agentDirectory, "test");
      if (result.message) result.message = redact(result.message);
      return result;
    } catch (cause) {
      throw new Error(redact(cause instanceof Error ? cause.message : String(cause)));
    }
  }
  async installDraft(id: string, revision: string): Promise<PluginSetupSummary> {
    const state = await this.#loadState(id);
    this.#hold(state, "Wait for the builder to finish before installing");
    let packageInstalled = false;
    try {
      // No turn starts meanwhile, so what is installed is what was reviewed.
      await this.projects.exclusive(state.projectId, async () => {
        const draft = await this.draft(id);
        if (draft.errors.length || !draft.plugin || !state.draftPath) throw new Error(draft.errors.join("\n") || "No valid plugin draft yet");
        if (draft.revision !== revision) throw new Error("The draft changed. Review it again before installing");
        const root = await pluginDraftPath(this.#workspace(id), state.draftPath);
        // Workspaces install one at a time, so none passes these checks while another replaces the package.
        const entry = await this.#oneInstallAtATime(async () => {
          await this.services.ready();
          const current = this.services.index.get(draft.plugin!.id);
          if (current && state.pluginId !== current.id) throw new Error("A plugin with this name is already installed. Choose another name");
          if (current && current.digest !== state.baseRevision) throw new Error("The installed plugin changed. Start a new editing workspace");
          return this.services.installPersonal(root, { consent: true });
        });
        packageInstalled = true;
        // What the log says is about the version this replaces.
        this.services.logs.forget(entry.id);
        state.pluginId = entry.id;
        state.baseRevision = entry.digest;
        state.installedRevision = revision;
        state.updatedAt = Date.now();
      });
    } finally {
      if (packageInstalled) this.invalidate();
      state.busy = false;
      await this.#save(state);
    }
    return this.read(id);
  }
  #oneInstallAtATime<T>(install: () => Promise<T>): Promise<T> {
    const run = this.#installs.then(install, install);
    this.#installs = run.catch(() => {});
    return run;
  }
  /**
   * The draft of the workspace a project holds, as it runs there; undefined
   * for another project, or a workspace with no draft that passes its checks.
   */
  async draftRuntime(projectId: string, options: { fresh?: boolean } = {}): Promise<DraftRuntime | undefined> {
    const state = [...this.#states.values()].find(state => state.projectId === projectId)
      ?? (await this.#all()).find(state => state.projectId === projectId);
    return state ? this.#draftRuntime(state, options.fresh) : undefined;
  }
  /** A draft's runtime by its workspace, as the plugin page server asks for a `_draft/<id>` page. */
  async draftRuntimeOf(setupId: string): Promise<DraftRuntime | undefined> {
    const state = await this.#loadState(setupId).catch(() => undefined);
    return state ? this.#draftRuntime(state) : undefined;
  }
  /** Whether a workspace is there, broken draft or not, so what its pages report is kept. */
  async hasWorkspace(setupId: string): Promise<boolean> {
    return Boolean(await this.#loadState(setupId).catch(() => undefined));
  }
  /** The panels of a project's draft, under its draft id. */
  async draftPanels(projectId: string, locale: PluginLocale, options: { fresh?: boolean } = {}): Promise<Array<ProjectPanel & { playground: string }>> {
    const runtime = await this.draftRuntime(projectId, options);
    return runtime ? entryPanels(runtime.entry, locale, runtime.plugin).map(panel => ({ ...panel, playground: runtime.playground })) : [];
  }
  /**
   * The draft as it runs now. `fresh` reads it again, as the panel list does
   * so that a changed draft gets a new address; a page's own requests reuse
   * a recent read. Never rejects: a draft that can't run has no runtime.
   */
  #draftRuntime(state: SetupRuntimeState, fresh = false): Promise<DraftRuntime | undefined> {
    const { draftPath } = state;
    if (!draftPath) return Promise.resolve(undefined);
    const cached = this.#runtimes.get(state.id);
    if (!fresh && cached && cached.draftPath === draftPath && Date.now() - cached.at < DRAFT_RUNTIME_REUSE_MS) return cached.runtime;
    const runtime = this.#readDraftRuntime(state, draftPath).catch(() => undefined);
    const entry = { at: Date.now(), draftPath, runtime };
    this.#runtimes.set(state.id, entry);
    void runtime.then(found => { if (!found && this.#runtimes.get(state.id) === entry) this.#runtimes.delete(state.id); });
    return runtime;
  }
  async #readDraftRuntime(state: SetupRuntimeState, draftPath: string): Promise<DraftRuntime | undefined> {
    const workspace = this.#workspace(state.id);
    const root = await pluginDraftPath(workspace, draftPath);
    const result = await indexPluginPackage(root);
    if (!result.ok || result.ignored?.length || !result.entry.id.startsWith(`${PERSONAL_PUBLISHER}/`)) return undefined;
    if (state.pluginId && result.entry.id !== state.pluginId) return undefined;
    // The playground is the draft's project and never part of it: a draft holding it, or in it, doesn't run here.
    const real = await realpath(workspace);
    const playground = path.join(real, DRAFT_PLAYGROUND);
    if (within(root, playground) || within(playground, root)) return undefined;
    // Only a draft with pages or code needs one.
    if (result.entry.manifest.contributes?.panels?.length || result.entry.manifest.entrypoints?.native) {
      await mkdir(playground, { recursive: true });
      // A link would take its pages outside the workspace.
      const found = await lstat(playground);
      if (found.isSymbolicLink() || !found.isDirectory()) return undefined;
    }
    return {
      setupId: state.id, plugin: draftPlugin(state.id), entry: result.entry, playground: path.join(workspace, DRAFT_PLAYGROUND),
      runAllowed: Boolean(result.entry.manifest.entrypoints?.native) && state.runAllowed === draftRunKey(result.entry.manifest),
    };
  }
  /** Lets the draft's native code run in its workspace, as it asks now; `key` is the one the person was shown. */
  async allowRun(id: string, key: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    const runtime = await this.#draftRuntime(state, true);
    if (!runtime?.entry.manifest.entrypoints?.native) throw new Error("Prepare a valid draft with native code first");
    if (draftRunKey(runtime.entry.manifest) !== key) throw new Error("The draft asks for something else now. Review it again");
    state.runAllowed = key;
    await this.#save(state);
    this.#runtimes.delete(id);
    // Its open pages load again, so one that was refused can run its code now.
    this.#changed?.(state.projectId);
    return this.draft(id);
  }
  /**
   * One of the draft's commands, as its page runs it in the preview: whether
   * it runs the draft's code, and whether it may change the playground's files.
   * Undefined when the draft has no such command.
   */
  async draftCommand(id: string, command: string): Promise<{ code: boolean; changesFiles: boolean } | undefined> {
    const runtime = await this.draftRuntimeOf(id);
    const found = runtime?.entry.manifest.contributes?.commands?.find(item => item.id === command);
    if (!found) return undefined;
    const { run } = found;
    return { code: "native" in run || "tool" in run, changesFiles: !("native" in run && run.changesFiles === false) };
  }
  /** Why the draft's code can't run now, or undefined when it can; checked before anything is recorded. */
  async runRefusal(id: string): Promise<string | undefined> {
    const state = await this.#loadState(id);
    const runtime = await this.#draftRuntime(state, true);
    if (!runtime) return "Prepare a valid draft first";
    if (!runtime.entry.manifest.entrypoints?.native) return "The draft has no native code to run";
    if (state.runAllowed !== draftRunKey(runtime.entry.manifest))
      return "The person hasn't allowed this draft's code to run, as it asks now. They can allow it under Try its code in the Overview";
    return undefined;
  }
  /**
   * Runs one of the draft's tools, commands or hooks in its workspace: in a
   * host of its own, with the playground as its project, once the person
   * allowed what it asks for. What it logged meanwhile comes back with it.
   * A workspace's runs take turns, so one never stops the host another runs in.
   */
  runDraft(id: string, target: DraftRunTarget, input: unknown, signal?: AbortSignal): Promise<PluginDraftRun> {
    const run = (this.#runs.get(id) ?? Promise.resolve()).then(() => this.#runDraft(id, target, input, signal));
    const queued = run.catch(() => {});
    this.#runs.set(id, queued);
    void queued.then(() => { if (this.#runs.get(id) === queued) this.#runs.delete(id); });
    return run;
  }
  async #runDraft(id: string, target: DraftRunTarget, input: unknown, signal?: AbortSignal): Promise<PluginDraftRun> {
    signal?.throwIfAborted();
    const refusal = await this.runRefusal(id);
    if (refusal) throw new Error(refusal);
    const state = await this.#loadState(id);
    const runtime = (await this.#draftRuntime(state))!;
    const { entry, plugin } = runtime;
    const scope = draftScope(id);
    // A host keeps the modules it imported, so changed code needs a new one.
    if (this.#hostDigests.get(id) !== entry.digest) {
      await this.services.native.stopScope(scope);
      this.#hostDigests.set(id, entry.digest);
    }
    const since = this.services.logs.added(plugin);
    const log = () => this.services.logs.since(plugin, since).slice(-LOG_ENTRIES_FOR_AGENT);
    try {
      const result = await this.services.runDraft(entry, target, {
        id: plugin, scope, folder: await realpath(runtime.playground), dataFolder: path.join(this.#directory(id), "data"), input, signal,
      });
      return { ok: true, result, log: log() };
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause), log: log() };
    }
  }
  /** Tells a workspace's open pages that what its draft may do changed: as an event of its project. */
  serveChanges(changed: (projectId: string) => void): void {
    this.#changed = changed;
  }
  /** How a capture request reaches the workspace's open page: as an event of its project. */
  serveCaptures(publish: (projectId: string, data: RuntimeEventData["plugin.draft.capture"]) => void): void {
    this.#publishCapture = publish;
  }
  /**
   * A screenshot of one of the draft's panels as the open workspace shows
   * it, taken by the desktop app: the workspace shows the panel, captures
   * it and answers with `answerCapture`. Refused when nobody answers in time,
   * as when the workspace isn't open in the desktop app.
   */
  async capture(id: string, panel: string | undefined, signal?: AbortSignal): Promise<DraftCapture> {
    const state = await this.#loadState(id);
    const runtime = await this.#draftRuntime(state, true);
    const panels = runtime?.entry.manifest.contributes?.panels ?? [];
    if (!panels.length) throw new Error("The draft has no panel to see. Prepare a valid draft with a panel first");
    if (panel !== undefined && !panels.some(item => item.id === panel)) throw new Error(`The draft has no panel ${panel}. Its panels: ${panels.map(item => item.id).join(", ")}`);
    if (!this.#publishCapture) throw new Error("Panels can only be seen in the desktop app");
    const request = randomUUID();
    return new Promise<DraftCapture>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.#captures.delete(request); };
      const timer = setTimeout(() => { done(); reject(new Error("Nobody answered: the preview can only be seen while this workspace is open in the desktop app. Ask the person to open it, or to look at the preview themselves")); }, DRAFT_CAPTURE_TIMEOUT_MS);
      const abort = () => { done(); reject(new Error("Cancelled")); };
      signal?.addEventListener("abort", abort, { once: true });
      this.#captures.set(request, {
        setupId: id,
        resolve: (image) => { done(); resolve(image); },
        reject: (error) => { done(); reject(error); },
      });
      this.#publishCapture!(state.projectId, {
        setupId: id, request, ...(panel ? { panel } : {}),
        // The address its preview loads it from carries the same part of its digest.
        revision: runtime!.entry.digest.slice(0, 16),
        expires: Date.now() + DRAFT_CAPTURE_TIMEOUT_MS,
      });
    });
  }
  /** The open workspace's answer to a capture request: the image, or why it couldn't take one. */
  answerCapture(id: string, request: string, answer: { image?: DraftCapture; error?: string }): boolean {
    const waiting = this.#captures.get(request);
    if (!waiting || waiting.setupId !== id) return false;
    if (answer.image) waiting.resolve(answer.image);
    else waiting.reject(new Error(answer.error ?? "The panel couldn't be captured"));
    return true;
  }
  /** The tool an agent drafts a workspace's plugin with; a project of another kind has none. */
  async agentTools(project: Pick<ProjectState, "id" | "type">): Promise<ToolDefinition[]> {
    if (project.type !== "plugin") return [];
    const state = (await this.#all()).find(state => state.projectId === project.id);
    return state ? [this.#tool(state)] : [];
  }

  #tool(state: SetupRuntimeState): ToolDefinition {
    return {
      name: "plugin_manage",
      label: "Manage plugin",
      description:
        `Omit id. This session works on its draft: list (installed plugins), read (the draft), read-skill (server: skill ID), prepare (input: path) validates files and refreshes the preview, test (server), logs (what the draft's panels and code reported since the last prepare, and the installed version's), run (input: {tool|command|hook: name, input?}) runs the draft's native code with ${DRAFT_PLAYGROUND}/ as its project and returns the result and what it logged; a hook takes a made-up event as input. The person allows the draft's code once in the Overview, and again when what it asks for changes. preview (input: {panel?}) shows you a screenshot of one of the draft's panels as the open workspace shows it, in the desktop app. Edit the draft's files and prepare again; users install drafts from the preview. After prepare, the draft's panels show beside the chat as a live preview whose project files are this workspace's ${DRAFT_PLAYGROUND}/ folder.`,
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("read"),
          Type.Literal("read-skill"),
          Type.Literal("prepare"),
          Type.Literal("test"),
          Type.Literal("logs"),
          Type.Literal("run"),
          Type.Literal("preview"),
        ]),
        id: Type.Optional(Type.String()),
        server: Type.Optional(Type.String()),
        input: Type.Optional(Type.Unknown()),
      }),
      execute: async (_callId, raw, signal) => {
        const params = raw as {
          action: string;
          id?: string;
          server?: string;
          input?: unknown;
        };
        try {
          if (params.id) throw new Error("This session works on its own draft; omit id");
          if (params.action === "preview") {
            const panel = (params.input as { panel?: unknown } | undefined)?.panel;
            const image = await this.capture(state.id, typeof panel === "string" ? panel : undefined, signal);
            return {
              content: [
                { type: "text", text: JSON.stringify({ panel: image.panel, width: image.width, height: image.height, theme: image.theme }) },
                { type: "image", data: image.data, mimeType: image.mediaType },
              ],
              details: {},
            };
          }
          let result: unknown;
          if (params.action === "list") {
            await this.services.ready();
            result = this.services.index.entries().map((entry) => ({ id: entry.id, version: entry.version, displayName: localizePluginString(entry, entry.manifest.displayName, "en") }));
          } else if (params.action === "prepare") {
            const input = params.input as { path?: string } | undefined;
            if (!input?.path) throw new Error("Specify the plugin draft directory");
            result = await this.prepare(state.id, input.path);
          } else if (params.action === "read") result = await this.draft(state.id);
          else if (params.action === "read-skill") {
            const draft = await this.draft(state.id);
            if (!draft.plugin?.skills.some(skill => skill.id === params.server)) throw new Error("Skill not found in this draft");
            result = await this.file(state.id, params.server!);
          } else if (params.action === "test") {
            result = await this.#testDraft(state, params.server ?? "");
            await this.#save(state);
          } else if (params.action === "run") {
            const [target, input] = draftRunInput(params.input);
            result = await this.runDraft(state.id, target, input, signal);
          } else if (params.action === "logs") {
            await this.services.ready();
            const installed = state.pluginId ? this.services.log(state.pluginId) : undefined;
            result = {
              draft: recentLog(this.services.log(draftPlugin(state.id)).entries),
              ...(installed ? { installed: { plugin: state.pluginId, quarantined: installed.quarantined, entries: recentLog(installed.entries) } } : {}),
            };
          } else throw new Error(`Unknown action: ${params.action}`);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: {},
          };
        } catch (cause) {
          return {
            content: [
              {
                type: "text",
                text: cause instanceof Error ? cause.message : String(cause),
              },
            ],
            details: { error: true },
            isError: true,
          };
        }
      },
    };
  }
  #save(state: SetupRuntimeState): Promise<void> {
    const filePath = path.join(this.#directory(state.id), "state.json");
    const contents = JSON.stringify(state);
    const write = (this.#writes.get(state.id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
          await rename(temporary, filePath);
        } finally {
          await rm(temporary, { force: true });
        }
      });
    this.#writes.set(state.id, write);
    void write
      .finally(() => {
        if (this.#writes.get(state.id) === write) this.#writes.delete(state.id);
      })
      .catch(() => {});
    return write;
  }
}

/** The host scope a workspace's draft runs in, apart from every project's. */
function draftScope(setupId: string): string {
  return `draft:${setupId}`;
}

/** The agent's `run` input as a target and the input for it. */
function draftRunInput(value: unknown): [DraftRunTarget, unknown] {
  const input = (value ?? {}) as { tool?: unknown; command?: unknown; hook?: unknown; input?: unknown };
  const named = (["tool", "command", "hook"] as const).filter((kind) => typeof input[kind] === "string");
  if (named.length !== 1) throw new Error("Name one of tool, command or hook to run");
  const kind = named[0]!;
  return [{ [kind]: input[kind] as string } as DraftRunTarget, input.input];
}

/** Whether `inner` is `outer` or inside it; both are real paths. */
function within(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The agent reads the newest of a log, which is what explains what just happened. */
const LOG_ENTRIES_FOR_AGENT = 50;
function recentLog<T>(entries: readonly T[]): T[] {
  return entries.slice(-LOG_ENTRIES_FOR_AGENT);
}

export function registerPluginSetupRoutes(
  app: FastifyInstance,
  manager: PluginSetupManager,
) {
  app.get("/plugins/setup-sessions", () => manager.list());
  app.post<{ Body: { pluginId?: string; mode?: PluginSetupMode } }>(
    "/plugins/setup-sessions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { pluginId: { type: "string" }, mode: { enum: ["create", "edit"] } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply
          .code(201)
          .send(await manager.create(request.body?.pluginId, request.body?.mode));
      } catch (cause) {
        return reply.code(400).send({ error: String(cause) });
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/plugins/setup-sessions/:id",
    async (request, reply) => {
      try {
        return await manager.read(request.params.id);
      } catch {
        return reply
          .code(404)
          .send({ error: "Plugin assistant session not found" });
      }
    },
  );
  app.get<{ Params: { id: string } }>("/plugins/setup-sessions/:id/draft", async (request, reply) => {
    try { return await manager.draft(request.params.id); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/plugins/setup-sessions/:id/icon", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { path: { type: "string", minLength: 1, maxLength: 1000 } } } },
  }, async (request, reply) => {
    try {
      const image = await manager.icon(request.params.id, request.query.path);
      if (!image) return reply.code(404).send({ error: "Plugin icon not found" });
      return reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "default-src 'none'; sandbox").type(image.mediaType).send(image.bytes);
    } catch { return reply.code(404).send({ error: "Plugin icon not found" }); }
  });
  app.put<{ Params: { id: string }; Body: PluginIconUpdate }>("/plugins/setup-sessions/:id/icon", {
    bodyLimit: Math.ceil(PLUGIN_ICON_MAX_BYTES / 3) * 4 + 2048,
    schema: { body: {
      type: "object", required: ["revision"], additionalProperties: false,
      oneOf: [{ required: ["icon"] }, { required: ["image"] }],
      properties: {
        revision: { type: "string", pattern: "^[0-9a-f]{64}$" },
        icon: { anyOf: [{ type: "null" }, { type: "object", required: ["type", "path"], additionalProperties: false, properties: {
          type: { enum: ["asset"] }, path: { type: "string", maxLength: 1000 },
        } }] },
        image: { type: "object", required: ["mediaType", "data"], additionalProperties: false, properties: {
          mediaType: { enum: Object.values(PLUGIN_ICON_MEDIA_TYPES) }, data: { type: "string", minLength: 1, maxLength: Math.ceil(PLUGIN_ICON_MAX_BYTES / 3) * 4 },
        } },
      },
    } },
  }, async (request, reply) => {
    try { return await manager.updateIcon(request.params.id, request.body); }
    catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.delete<{ Params: { id: string } }>("/plugins/setup-sessions/:id", async (request, reply) => {
    try {
      await manager.remove(request.params.id);
      return reply.code(204).send();
    } catch (cause) {
      return reply.code((cause as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 409)
        .send({ error: cause instanceof Error ? cause.message : String(cause) });
    }
  });
  app.get<{ Params: { id: string }; Querystring: { path: string } }>("/plugins/setup-sessions/:id/file", {
    schema: { querystring: { type: "object", required: ["path"], additionalProperties: false, properties: { path: { type: "string", minLength: 1 } } } },
  }, async (request, reply) => {
    try { return await manager.file(request.params.id, request.query.path); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
  });
  app.post<{ Params: { id: string }; Body: { revision: string } }>("/plugins/setup-sessions/:id/install", {
    schema: { body: { type: "object", required: ["revision"], additionalProperties: false, properties: { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } } } },
  }, async (request, reply) => {
    try { return await manager.installDraft(request.params.id, request.body.revision); }
    catch (cause) { return reply.code(409).send({ error: String(cause) }); }
  });
  app.post<{ Params: { id: string; request: string }; Body: { image?: DraftCapture; error?: string } }>("/plugins/setup-sessions/:id/captures/:request", {
    bodyLimit: 12 * 1024 * 1024,
    schema: { body: { type: "object", additionalProperties: false, minProperties: 1, maxProperties: 1, properties: {
      error: { type: "string", minLength: 1, maxLength: 1000 },
      image: { type: "object", additionalProperties: false, required: ["panel", "mediaType", "data", "width", "height", "theme"], properties: {
        panel: { type: "string", minLength: 1, maxLength: 200 }, mediaType: { enum: ["image/webp", "image/png"] },
        data: { type: "string", minLength: 1, maxLength: 11 * 1024 * 1024, pattern: "^[A-Za-z0-9+/]+={0,2}$" },
        width: { type: "integer", minimum: 1, maximum: 10000 }, height: { type: "integer", minimum: 1, maximum: 10000 }, theme: { enum: ["light", "dark"] },
      } },
    } } },
  }, async (request, reply) => manager.answerCapture(request.params.id, request.params.request, request.body)
    ? reply.code(204).send()
    : reply.code(404).send({ error: "No capture is waiting for this answer" }));
  app.post<{ Params: { id: string }; Body: { key: string } }>("/plugins/setup-sessions/:id/allow-run", {
    schema: { body: { type: "object", required: ["key"], additionalProperties: false, properties: { key: { type: "string", pattern: "^[0-9a-f]{32}$" } } } },
  }, async (request, reply) => {
    try { return await manager.allowRun(request.params.id, request.body.key); }
    catch (cause) { return reply.code(409).send({ error: cause instanceof Error ? cause.message : String(cause) }); }
  });
  app.post<{ Params: { id: string; server: string }; Body: { revision: string } }>("/plugins/setup-sessions/:id/test/:server", {
    schema: { body: { type: "object", required: ["revision"], additionalProperties: false, properties: { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } } } },
  }, async (request, reply) => {
    try { return await manager.testDraft(request.params.id, request.params.server, request.body.revision); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
  });
}
