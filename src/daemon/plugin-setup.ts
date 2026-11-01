import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import type {
  PluginSetupPrompt,
  PluginSetupState,
  PluginSetupSummary,
  PluginDraft,
  PluginIconUpdate,
  PluginSetupMode,
} from "../shared/plugin-setup.js";
import type { PluginConfigurationValues, PluginMcpResult } from "../shared/plugins.js";
import { compatibleRuntimeModel, conversationItems, lastAssistantError } from "./agent.js";
import type { ThreadItem, Turn } from "../shared/contracts.js";
import type { RuntimeModel } from "./agent.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";
import type { PluginCatalogService } from "./plugin-catalog.js";
import type { PluginServices } from "./plugin-services.js";
import { inspectPluginDraft, inspectPluginFiles, pluginDraftPath, readPluginDraftFile } from "./plugin-draft.js";
import { PLUGIN_AUTHORING_RULES } from "./plugin-authoring.js";
import { openRouterAttributionExtension } from "./openrouter-attribution.js";
import { isPluginIcon, PLUGIN_MANIFEST_PATH } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { localizePluginString } from "./plugin-index.js";
import { PLUGIN_ICON_MAX_BYTES, PLUGIN_ICON_MEDIA_TYPES } from "../shared/plugin-icons.js";
import { readPluginIconAsset, validatePluginIconImage } from "./plugin-icons.js";

const SETUP_PROMPT = `You create and edit native OhMyGame plugins in this Plugin Builder workspace.
${PLUGIN_AUTHORING_RULES}
Read existing files before editing. Use read/write/edit/bash to author files, then plugin_manage prepare with input {path: "relative/plugin-directory"} to validate and refresh the preview; correct reported errors. Use plugin_manage read and test on the current draft. Never modify credentials or session files. The user installs or updates the reviewed draft from the preview, then fills in any settings on the plugin's page. Report its actual state and required input, concisely and in the user's language.`;

const CONFIGURE_PROMPT = `You help users understand, configure and diagnose the selected OhMyGame plugin. Use plugin_manage read and read-skill to inspect it before suggesting changes. Configure only this plugin's nonsecret fields and MCP templates, and test its connections. Explain changes and required input. Never ask for secrets in chat; direct the user to the configuration form or OAuth controls. Do not author or install packages. Match the user's language.`;

type SetupRuntimeState = PluginSetupSummary & { busy: boolean; error?: string; draftPath?: string; installedRevision?: string; baseRevision?: string; checks?: PluginDraft["checks"] };

export class PluginSetupManager {
  #states = new Map<string, SetupRuntimeState>();
  #history = new Map<string, SessionManager>();
  #writes = new Map<string, Promise<void>>();
  #sessions = new Map<string, AgentSession>();
  #closed = false;
  #runs = new Set<Promise<void>>();
  #aborted = new Set<string>();
  #live = new Map<string, ThreadItem[]>();
  constructor(
    private readonly dataDirectory: string,
    private readonly agentDirectory: string,
    private readonly capabilities: PluginCapabilities,
    private readonly plugins: PluginCatalogService,
    private readonly services: PluginServices,
    private readonly invalidate: () => void,
    private readonly model: (
      ref: PluginSetupPrompt["model"],
    ) => Promise<{ runtime: ModelRuntime; model: RuntimeModel }>,
  ) {}
  #directory(id: string): string {
    return path.join(this.dataDirectory, "plugin-setup", id);
  }
  async create(pluginId?: string, mode: PluginSetupMode = pluginId ? "configure" : "create"): Promise<PluginSetupState> {
    if (this.#closed) throw new Error("Plugin assistant is closed");
    if (mode === "create" && pluginId) throw new Error("Create a new plugin without an installed target");
    const plugin = mode === "configure" && pluginId ? await this.plugins.read(pluginId) : undefined;
    if (mode === "configure" && !plugin?.installed) throw new Error("Select an installed plugin");
    await this.services.ready();
    const editing = mode === "edit" && pluginId ? this.services.index.get(pluginId) : undefined;
    if (mode === "edit" && !editing) throw new Error("Select an installed plugin");
    if (editing && !editing.id.startsWith(`${PERSONAL_PUBLISHER}/`)) throw new Error("Only a plugin you made can be edited");
    const id = randomUUID();
    const state: SetupRuntimeState = {
      id,
      mode,
      pluginId,
      busy: false,
      title: plugin?.displayName ?? (editing ? localizePluginString(editing, editing.manifest.displayName, "en") : "New plugin"),
      createdAt: Date.now(), updatedAt: Date.now(), status: "idle",
    };
    await mkdir(this.#directory(state.id), { recursive: true });
    const workspace = path.join(this.#directory(state.id), "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      if (editing) {
        const name = editing.id.slice(editing.id.indexOf("/") + 1);
        const root = path.join(workspace, name);
        await cp(editing.root, root, { recursive: true, verbatimSymlinks: true });
        state.baseRevision = editing.digest;
        state.draftPath = name;
        state.installedRevision = (await inspectPluginFiles(root)).revision;
        state.status = "installed";
      }
    } catch (cause) {
      await rm(this.#directory(state.id), { recursive: true, force: true });
      throw cause;
    }
    this.#states.set(state.id, state);
    await this.#save(state);
    return this.read(state.id);
  }
  async read(id: string): Promise<PluginSetupState> {
    const state = await this.#loadState(id);
    return { ...structuredClone(summary(state)), busy: state.busy, error: state.error, turns: this.#turns(id, state) };
  }
  async #loadState(id: string): Promise<SetupRuntimeState> {
    if (!/^[0-9a-f-]{36}$/.test(id))
      throw new Error("Invalid plugin setup session");
    let state = this.#states.get(id);
    if (!state) {
      const stored = JSON.parse(
        await readFile(path.join(this.#directory(id), "state.json"), "utf8"),
      ) as SetupRuntimeState;
      state = {
        id,
        mode: stored.mode ?? (stored.draftPath ? "create" : stored.pluginId ? "configure" : "create"),
        pluginId: stored.pluginId,
        error: stored.error,
        busy: false,
        title: stored.title ?? "Plugin workspace",
        createdAt: stored.createdAt ?? Date.now(), updatedAt: stored.updatedAt ?? Date.now(),
        status: stored.status === "working" ? "interrupted" : stored.status ?? "idle",
        model: stored.model, reasoningLevel: stored.reasoningLevel,
        draftPath: stored.draftPath, installedRevision: stored.installedRevision,
        baseRevision: stored.baseRevision,
        checks: stored.checks,
      };
      // Keep the first concurrent reader's state so a prompt cannot be hidden
      // by another request loading the same session from disk.
      state = this.#states.get(id) ?? state;

      this.#states.set(id, state);
    }
    if (state.pluginId && !state.busy) {
      const pluginId = state.pluginId;
      const installed = await this.#installed(state);
      if (!installed && state.pluginId === pluginId && !state.busy) {
        state.pluginId = undefined;
        state.installedRevision = undefined;
        state.baseRevision = undefined;
        state.checks = {};
        if (state.status === "installed") state.status = state.draftPath ? "ready" : "idle";
        state.updatedAt = Date.now();
        this.#sessions.get(id)?.dispose();
        this.#sessions.delete(id);
        await this.#save(state);
      }
    }
    return state;
  }
  /** A configuration session looks after a format 1 plugin; the others make format 2 ones. */
  async #installed(state: SetupRuntimeState): Promise<boolean> {
    if (state.mode === "configure") return Boolean((await this.plugins.read(state.pluginId!))?.installed);
    await this.services.ready();
    return this.services.index.versions(state.pluginId!).length > 0;
  }
  async list(): Promise<PluginSetupSummary[]> {
    const directory = path.join(this.dataDirectory, "plugin-setup");
    const entries = await readdir(directory).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    const results = await Promise.allSettled(entries.filter(id => /^[0-9a-f-]{36}$/.test(id)).map(id => this.#loadState(id)));
    return results.flatMap(result => result.status === "fulfilled" ? [summary(result.value)] : [])
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async remove(id: string): Promise<void> {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("Wait for the builder to finish before deleting its workspace");
    state.busy = true;
    try {
      await this.#writes.get(id);
      this.#sessions.get(id)?.dispose();
      this.#sessions.delete(id);
      const directory = this.#directory(id);
      const removed = `${directory}.removed-${randomUUID()}`;
      await rename(directory, removed);
      this.#states.delete(id);
      this.#history.delete(id);
      this.#writes.delete(id);
      this.#aborted.delete(id);
      this.#live.delete(id);
      await rm(removed, { recursive: true, force: true });
    } finally { state.busy = false; }
  }
  async clearConversation(id: string): Promise<PluginSetupState> {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("Stop the assistant before deleting its conversation");
    state.busy = true;
    try {
      await this.#writes.get(id);
      this.#sessions.get(id)?.dispose();
      this.#sessions.delete(id);
      await rm(path.join(this.#directory(id), "sessions"), { recursive: true, force: true });
      this.#history.delete(id);
      this.#live.delete(id);
      this.#aborted.delete(id);
      state.error = undefined;
      state.status = state.pluginId && state.installedRevision ? "installed" : state.draftPath ? "ready" : "idle";
      state.updatedAt = Date.now();
    } finally { state.busy = false; await this.#save(state); }
    return this.read(id);
  }
  #turns(id: string, state: SetupRuntimeState): Turn[] {
    const items = conversationItems(this.#sessionManager(id).getBranch(), !state.busy);
    const live = this.#live.get(id) ?? [];
    for (const item of live) {
      const index = items.findIndex(existing => existing.id === item.id);
      if (index < 0) items.push(item); else items[index] = item;
    }
    const grouped = new Map<string, Turn>();
    for (const item of items) {
      let turn = grouped.get(item.turnId);
      if (!turn) { turn = { id: item.turnId, conversationId: id, status: "completed", items: [] }; grouped.set(item.turnId, turn); }
      turn.items.push(item);
      if ("status" in item && item.status === "failed") turn.status = "failed";
      if ("status" in item && item.status === "interrupted") turn.status = "interrupted";
    }
    const turns = [...grouped.values()];
    const latest = turns.at(-1);
    if (latest && state.busy) latest.status = "inProgress";
    return turns;
  }
  async draft(id: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    if (!state.draftPath) return { files: [], errors: [] };
    const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
    const draft = await inspectPluginDraft(root, state.installedRevision);
    if (draft.plugin && state.pluginId && draft.plugin.id !== state.pluginId) {
      draft.errors.push(`This draft updates ${state.pluginId}, so it must keep that id`);
      draft.plugin = undefined;
    }
    return { ...draft, path: state.draftPath, checks: state.checks };
  }
  async prepare(id: string, requested: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    if (state.mode === "configure") throw new Error("Configuration sessions cannot author plugin packages");
    const workspace = path.join(this.#directory(id), "workspace");
    const root = await pluginDraftPath(workspace, requested);
    state.draftPath = path.relative(workspace, root) || ".";
    const draft = await this.draft(id);
    if (draft.plugin) state.title = draft.plugin.displayName;
    if (!state.busy) state.status = draft.errors.length ? "error" : "ready";
    state.updatedAt = Date.now();
    await this.#save(state);
    return draft;
  }
  async file(id: string, requested: string) {
    const state = await this.#loadState(id);
    if (!state.draftPath) throw new Error("No plugin draft yet");
    const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
    return readPluginDraftFile(root, requested);
  }
  async icon(id: string, requested?: string) {
    const state = await this.#loadState(id);
    if (!state.draftPath) return undefined;
    const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
    if (requested) return readPluginIconAsset(root, { type: "asset", path: requested });
    const { content } = await readPluginDraftFile(root, PLUGIN_MANIFEST_PATH);
    const { icon } = JSON.parse(content) as { icon?: unknown };
    return readPluginIconAsset(root, typeof icon === "string" ? { type: "asset", path: icon } : undefined);
  }
  async updateIcon(id: string, input: PluginIconUpdate): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("Wait for the builder to finish before changing its icon");
    state.busy = true;
    try {
      const draft = await this.draft(id);
      if (!draft.plugin || draft.errors.length || !state.draftPath) throw new Error("Prepare a valid draft before changing its icon");
      if (draft.revision !== input.revision) throw new Error("The draft changed. Refresh the preview before changing its icon");
      const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
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
      if (icon && (icon.type !== "asset" || !isPluginIcon(icon))) throw new Error("Choose a PNG/WebP/SVG path inside the plugin");
      await readPluginIconAsset(root, icon ?? undefined);
      const file = path.join(root, PLUGIN_MANIFEST_PATH);
      const manifest = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      if (icon?.type === "asset") manifest.icon = icon.path; else delete manifest.icon;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      state.checks = {};
      state.status = "ready";
      state.updatedAt = Date.now();
      return await this.draft(id);
    } finally { state.busy = false; await this.#save(state); }
  }
  async testDraft(id: string, server: string, revision: string) {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("Wait for the builder to finish before testing");
    state.busy = true;
    try { return await this.#testDraft(state, server, revision); }
    finally { state.busy = false; await this.#save(state); }
  }
  async #testDraft(state: SetupRuntimeState, server: string, revision?: string) {
    const draft = await this.draft(state.id);
    if (!draft.plugin || draft.errors.length || !state.draftPath || !draft.revision) throw new Error("Prepare a valid draft before testing");
    if (revision !== undefined && draft.revision !== revision) throw new Error("The draft changed. Refresh the preview before testing");
    const root = await pluginDraftPath(path.join(this.#directory(state.id), "workspace"), state.draftPath);
    const { definition, secrets } = await this.services.draftMcpServer(root, server);
    const result: PluginMcpResult = definition
      ? await this.capabilities.testDefinition(`draft:${state.id}:${server}`, `draft-${state.id}-${server}`, definition, secrets)
      : { status: "failed", toolCount: 0, message: "Install the plugin and fill in its settings, then test this server" };
    state.checks = { ...state.checks, [server]: { revision: draft.revision, result } };
    return result;
  }
  async installDraft(id: string, revision: string): Promise<PluginSetupState> {
    const state = await this.#loadState(id);
    if (state.mode === "configure") throw new Error("Configuration sessions cannot install plugin packages");
    if (state.busy) throw new Error("Wait for the builder to finish before installing");
    state.busy = true;
    let packageInstalled = false;
    try {
      const draft = await this.draft(id);
      if (draft.errors.length || !draft.plugin || !state.draftPath) throw new Error(draft.errors.join("\n") || "No valid plugin draft yet");
      if (draft.revision !== revision) throw new Error("The draft changed. Review it again before installing");
      const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
      await this.services.ready();
      const current = this.services.index.get(draft.plugin.id);
      if (current && state.pluginId !== current.id) throw new Error("A plugin with this name is already installed. Choose another name");
      if (current && current.digest !== state.baseRevision) throw new Error("The installed plugin changed. Start a new editing workspace");
      const entry = await this.services.installPersonal(root, { consent: true });
      packageInstalled = true;
      state.pluginId = entry.id;
      state.baseRevision = entry.digest;
      state.installedRevision = revision;
      state.status = "installed"; state.error = undefined; state.updatedAt = Date.now();
    } catch (cause) {
      state.status = "error";
      state.error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      if (packageInstalled) this.invalidate();
      state.busy = false;
      await this.#save(state);
    }
    return this.read(id);
  }
  #sessionManager(id: string): SessionManager {
    let history = this.#history.get(id);
    if (!history) {
      history = SessionManager.continueRecent(
        path.join(this.#directory(id), "workspace"),
        path.join(this.#directory(id), "sessions"),
      );
      this.#history.set(id, history);
    }
    return history;
  }
  async prompt(id: string, input: PluginSetupPrompt): Promise<void> {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("The plugin assistant is already working");
    if (this.#closed) throw new Error("Plugin assistant is closed");
    if (state.mode === "configure" && !state.pluginId) throw new Error("This plugin is no longer installed");
    state.busy = true;
    state.status = "working";
    state.model = input.model;
    state.reasoningLevel = input.reasoningLevel;
    state.updatedAt = Date.now();
    if (state.title === "New plugin") state.title = input.prompt.trim().slice(0, 64);
    this.#aborted.delete(id);
    state.error = undefined;
    const initialWrite = this.#save(state);
    // Track model lookup and initialization as part of the run, so close/abort
    // covers the entire operation rather than only the inference phase.
    const run = (async () => {
      await initialWrite;
      if (this.#closed || this.#aborted.has(id)) return;
      const selected = await this.model(input.model);
      if (this.#closed || this.#aborted.has(id)) return;
      await this.#run(state, input.prompt, selected);
    })()
      .catch((cause) => {
        state.error = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(async () => {
        state.busy = false;
        this.#live.delete(id);
        state.status = state.error ? "error" : this.#aborted.has(id) || this.#closed ? "interrupted" : state.draftPath ? "ready" : "idle";
        state.updatedAt = Date.now();
        await this.#save(state);
      });
    this.#runs.add(run);
    void run.finally(() => this.#runs.delete(run)).catch(() => {});
    await initialWrite;
  }
  async #run(
    state: SetupRuntimeState,
    prompt: string,
    selected: { runtime: ModelRuntime; model: RuntimeModel },
  ): Promise<void> {
    let session = this.#sessions.get(state.id);
    if (!session) {
      const cwd = path.join(this.#directory(state.id), "workspace");
      await mkdir(cwd, { recursive: true });
      const settingsManager = SettingsManager.inMemory({
        packages: [],
        cacheWarming: "off",
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: this.agentDirectory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt:
          (state.mode === "configure" ? CONFIGURE_PROMPT : SETUP_PROMPT) +
          (state.pluginId ? `\nThe selected plugin is ${state.pluginId}.` : ""),
        extensionFactories: [
          {
            name: "openrouter-attribution",
            factory: openRouterAttributionExtension,
          },
        ],
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir: this.agentDirectory,
        resourceLoader,
        settingsManager,
        modelRuntime: selected.runtime,
        model: compatibleRuntimeModel(selected.model),
        sessionManager: this.#sessionManager(state.id),
        customTools: [this.#tool(cwd, state)],
        ...(state.mode === "configure" ? { noTools: "builtin" as const } : {}),
      });
      session = created.session;
      this.#sessions.set(state.id, session);
      try {
        await session.bindExtensions({ mode: "rpc" });
      } catch (cause) {
        session.dispose();
        this.#sessions.delete(state.id);
        throw cause;
      }
    } else await session.setModel(compatibleRuntimeModel(selected.model));
    if (state.reasoningLevel) session.setThinkingLevel(state.reasoningLevel);
    if (this.#closed || this.#aborted.has(state.id)) {
      state.busy = false;
      session.dispose();
      this.#sessions.delete(state.id);
      return;
    }
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        if (event.message.role === "assistant")
        {
          const entries: SessionEntry[] = [...this.#sessionManager(state.id).getBranch(), {
            type: "message", id: `${state.id}:live`, parentId: null,
            timestamp: new Date().toISOString(), message: event.message as Extract<SessionEntry, { type: "message" }>["message"],
          }];
          this.#live.set(state.id, conversationItems(entries, false).filter(item => item.id.startsWith(`${state.id}:live`))
            .map(item => item.type === "agentMessage" || item.type === "reasoning" ? { ...item, status: "inProgress" } : item));
        }
      }
      if (event.type === "message_end") this.#live.delete(state.id);
    });
    try {
      await session.prompt(prompt);
      state.error = lastAssistantError(session.messages)?.message;
    } finally {
      unsubscribe();
    }
  }

  #tool(cwd: string, state: SetupRuntimeState): ToolDefinition {
    return {
      name: "plugin_manage",
      label: "Manage plugin",
      description:
        "Omit id. An authoring session works on its draft: list (installed plugins), read (the draft), read-skill (server: skill ID), prepare (input: path) validates files and refreshes the preview, test (server). Edit the draft's files and prepare again; users install drafts from the preview. A configuration session looks after the selected plugin: list, read (package and configuration state), read-skill (server: skill ID), configure (input: nonsecret values), test (server), definition (server), configure-server (server,input: complete MCP template).",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("read"),
          Type.Literal("read-skill"),
          Type.Literal("prepare"),
          Type.Literal("configure"),
          Type.Literal("definition"),
          Type.Literal("configure-server"),
          Type.Literal("test"),
        ]),
        id: Type.Optional(Type.String()),
        server: Type.Optional(Type.String()),
        input: Type.Optional(Type.Unknown()),
      }),
      execute: async (_callId, raw) => {
        const params = raw as {
          action: string;
          id?: string;
          server?: string;
          input?: unknown;
        };
        try {
          const id = params.id ?? (state.mode === "configure" ? state.pluginId : undefined);
          if (state.mode === "configure" && (params.action === "prepare" || (params.action !== "list" && id !== state.pluginId)))
            throw new Error("This session can only configure the selected plugin");
          if (state.mode !== "configure" && params.id) throw new Error("This session works on its own draft; omit id");
          let result: unknown;
          if (params.action === "list") {
            if (state.mode === "configure") result = await this.plugins.list();
            else {
              await this.services.ready();
              result = this.services.index.entries().map((entry) => ({ id: entry.id, version: entry.version, displayName: localizePluginString(entry, entry.manifest.displayName, "en") }));
            }
          } else if (params.action === "prepare") {
            const input = params.input as { path?: string } | undefined;
            if (!input?.path) throw new Error("Specify the plugin draft directory");
            result = await this.prepare(state.id, input.path);
          } else if (!id) {
            if (params.action === "read") result = await this.draft(state.id);
            else if (params.action === "read-skill") {
              const draft = await this.draft(state.id);
              if (!draft.plugin?.skills.some(skill => skill.id === params.server)) throw new Error("Skill not found in this draft");
              result = await this.file(state.id, params.server!);
            } else if (params.action === "test") {
              result = await this.#testDraft(state, params.server ?? "");
              await this.#save(state);
            } else throw new Error("Edit the draft's files and call prepare. The person fills in settings on the plugin's page once it is installed");
          } else {
            const plugin = await this.plugins.read(id);
            if (!plugin) throw new Error("Plugin not found");
            if (params.action === "read-skill") result = await this.capabilities.skillContent(plugin, params.server ?? "");
            if (params.action === "read")
              result = {
                plugin: await this.capabilities.decorate(plugin),
                configuration: this.capabilities.configuration.view(plugin),
              };
            if (params.action === "configure") {
              result = await this.capabilities.configuration.update(
                plugin,
                params.input as PluginConfigurationValues,
                false,
              );
              this.invalidate();
            }
            if (params.action === "definition")
              result = await this.capabilities.editableTemplate(
                plugin,
                params.server ?? "",
              );
            if (params.action === "configure-server") {
              await this.capabilities.setDefinition(
                plugin,
                params.server ?? "",
                params.input as import("../shared/plugins.js").McpServerDefinition,
                false,
              );
              this.invalidate();
              result = await this.capabilities.decorate(plugin);
            }
            if (params.action === "test")
              result = await this.capabilities.test(
                plugin,
                params.server ?? "",
              );
          }
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
  async abort(id: string): Promise<void> {
    this.#aborted.add(id);
    await this.#sessions.get(id)?.abort();
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(
      [...this.#sessions.values()].map((session) => session.abort()),
    );
    await Promise.allSettled([...this.#runs]);
    // A session may have finished initializing while close was awaiting runs.
    await Promise.allSettled(
      [...this.#sessions.values()].map(async (session) => {
        try {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        } finally {
          session.dispose();
        }
      }),
    );
    this.#sessions.clear();
    this.#history.clear();
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

function summary(state: PluginSetupSummary): PluginSetupSummary {
  const { id, mode, pluginId, title, createdAt, updatedAt, status, model, reasoningLevel } = state;
  return { id, mode, pluginId, title, createdAt, updatedAt, status, model, reasoningLevel };
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
          properties: { pluginId: { type: "string" }, mode: { enum: ["create", "configure", "edit"] } },
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
        icon: { anyOf: [{ type: "null" }, { type: "object", required: ["type"], additionalProperties: false, properties: {
          type: { enum: ["preset", "asset"] }, id: { type: "string", maxLength: 100 }, path: { type: "string", maxLength: 1000 },
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
  app.delete<{ Params: { id: string } }>("/plugins/setup-sessions/:id/conversation", async (request, reply) => {
    try { return await manager.clearConversation(request.params.id); }
    catch (cause) { return reply.code((cause as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 409)
      .send({ error: cause instanceof Error ? cause.message : String(cause) }); }
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
  app.post<{ Params: { id: string; server: string }; Body: { revision: string } }>("/plugins/setup-sessions/:id/test/:server", {
    schema: { body: { type: "object", required: ["revision"], additionalProperties: false, properties: { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } } } },
  }, async (request, reply) => {
    try { return await manager.testDraft(request.params.id, request.params.server, request.body.revision); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
  });
  app.post<{ Params: { id: string }; Body: PluginSetupPrompt }>(
    "/plugins/setup-sessions/:id/prompt",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "model"],
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 32_000 },
            reasoningLevel: { enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
            model: {
              type: "object",
              required: ["provider", "id"],
              additionalProperties: false,
              properties: {
                provider: { type: "string" },
                id: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await manager.prompt(request.params.id, request.body);
        return reply.code(202).send(await manager.read(request.params.id));
      } catch (cause) {
        return reply.code(409).send({
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/plugins/setup-sessions/:id/abort",
    async (request, reply) => {
      await manager.abort(request.params.id);
      return reply.code(204).send();
    },
  );
  app.addHook("onClose", () => manager.close());
}
