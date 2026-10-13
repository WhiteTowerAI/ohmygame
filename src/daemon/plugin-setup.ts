import { randomUUID } from "node:crypto";
import {
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
} from "../shared/plugin-setup.js";
import type {
  CreateMcpPluginRequest,
  PluginConfigurationValues,
} from "../shared/plugins.js";
import { compatibleRuntimeModel, conversationItems, lastAssistantError } from "./agent.js";
import type { ThreadItem, Turn } from "../shared/contracts.js";
import type { RuntimeModel } from "./agent.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";
import type { PluginCatalogService } from "./plugin-catalog.js";
import type { LocalPluginStore } from "./local-plugins.js";
import { mcpPluginPackage } from "./plugin-capabilities.js";
import { inspectPluginDraft, pluginDraftPath, readPluginDraftFile } from "./plugin-draft.js";
import { PLUGIN_AUTHORING_RULES } from "./plugin-authoring.js";
import { openRouterAttributionExtension } from "./openrouter-attribution.js";

const SETUP_PROMPT = `You help users create, configure and repair native OhMyGame plugins in a dedicated Plugin Builder workspace.
${PLUGIN_AUTHORING_RULES}
Use plugin_manage for structured operations. Call list/read before changing an existing plugin. Use bash/read/write/edit to author Skills and scripts in this workspace. Call prepare with input {path: "relative/plugin-directory"} when the draft is ready; fix its reported errors. create-mcp prepares an uninstalled draft for existing MCP services. The user reviews the preview and clicks Install plugin; do not claim a draft has been installed. After changes call prepare again so the preview stays current. Never modify credentials or session files.
For installed plugins you may configure nonsecret values, inspect or edit MCP templates and test connections. Keep answers concise, explain what changed and what input is still required, and match the user's language.`;

type SetupRuntimeState = PluginSetupSummary & { busy: boolean; configurationId: string; error?: string; draftPath?: string; installedRevision?: string; checks?: PluginDraft["checks"] };

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
    private readonly localPlugins: LocalPluginStore,
    private readonly invalidate: () => void,
    private readonly model: (
      ref: PluginSetupPrompt["model"],
    ) => Promise<{ runtime: ModelRuntime; model: RuntimeModel }>,
  ) {}
  #directory(id: string): string {
    return path.join(this.dataDirectory, "plugin-setup", id);
  }
  async create(pluginId?: string): Promise<PluginSetupState> {
    if (this.#closed) throw new Error("Plugin assistant is closed");
    const plugin = pluginId ? await this.plugins.read(pluginId) : undefined;
    if (pluginId && !plugin) throw new Error("Plugin not found");
    const id = randomUUID();
    const state: SetupRuntimeState = {
      id,
      pluginId,
      configurationId: pluginId ?? `draft:${id}`,
      busy: false,
      title: plugin?.displayName ?? "New plugin",
      createdAt: Date.now(), updatedAt: Date.now(), status: "idle",
    };
    this.#states.set(state.id, state);
    await mkdir(this.#directory(state.id), { recursive: true });
    await mkdir(path.join(this.#directory(state.id), "workspace"), { recursive: true });
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
        pluginId: stored.pluginId,
        configurationId: stored.configurationId ?? stored.pluginId ?? `draft:${id}`,
        error: stored.error,
        busy: false,
        title: stored.title ?? "Plugin workspace",
        createdAt: stored.createdAt ?? Date.now(), updatedAt: stored.updatedAt ?? Date.now(),
        status: stored.status === "working" ? "interrupted" : stored.status ?? "idle",
        model: stored.model, reasoningLevel: stored.reasoningLevel,
        draftPath: stored.draftPath, installedRevision: stored.installedRevision,
        checks: stored.checks,
      };
      // Keep the first concurrent reader's state so a prompt cannot be hidden
      // by another request loading the same session from disk.
      state = this.#states.get(id) ?? state;

      this.#states.set(id, state);
    }
    if (state.pluginId && !state.busy) {
      const pluginId = state.pluginId;
      const plugin = await this.plugins.read(pluginId);
      if (!plugin?.installed && state.pluginId === pluginId && !state.busy) {
        state.pluginId = undefined;
        state.installedRevision = undefined;
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
      if (state.pluginId && (await this.plugins.read(state.pluginId))?.installed)
        throw new Error("Uninstall the plugin before deleting its workspace");
      await this.#writes.get(id);
      this.#sessions.get(id)?.dispose();
      this.#sessions.delete(id);
      const directory = this.#directory(id);
      const removed = `${directory}.removed-${randomUUID()}`;
      await rename(directory, removed);
      try {
        await this.capabilities.configuration.remove(`draft:${id}`);
      } catch (cause) {
        await rename(removed, directory);
        throw cause;
      }
      this.#states.delete(id);
      this.#history.delete(id);
      this.#writes.delete(id);
      this.#aborted.delete(id);
      this.#live.delete(id);
      await rm(removed, { recursive: true, force: true });
    } finally { state.busy = false; }
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
    return { ...await inspectPluginDraft(root, state.installedRevision), path: state.draftPath, checks: state.checks };
  }
  async prepare(id: string, requested: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
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
  async configuration(id: string, values?: PluginConfigurationValues) {
    const draft = await this.draft(id);
    if (!draft.plugin || draft.errors.length) throw new Error("Prepare a valid draft before configuring it");
    const state = this.#states.get(id)!;
    const existing = await this.localPlugins.read(draft.plugin.id);
    if (existing && state.pluginId !== existing.id) throw new Error("A plugin with this name is already installed. Choose another name");
    const configurable = this.#configurationPlugin(state, draft.plugin);
    if (!values) return this.capabilities.configuration.view(configurable);
    if (state.busy) throw new Error("Wait for the builder to finish before changing configuration");
    state.busy = true;
    try {
      const result = await this.capabilities.configuration.update(configurable, values);
      state.checks = {}; state.updatedAt = Date.now();
      if (state.pluginId) this.invalidate();
      return result;
    } finally { state.busy = false; await this.#save(state); }
  }
  #configurationPlugin(state: SetupRuntimeState, plugin: import("../shared/plugins.js").PluginDetail) {
    return state.configurationId === plugin.id ? plugin : { ...plugin, id: `draft:${state.id}` };
  }
  async testDraft(id: string, server: string, revision: string) {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("Wait for the builder to finish before testing");
    state.busy = true;
    try {
      const draft = await this.draft(id);
      if (!draft.plugin || draft.errors.length || !state.draftPath) throw new Error("Prepare a valid draft before testing");
      if (draft.revision !== revision) throw new Error("The draft changed. Refresh the preview before testing");
      const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
      const result = await this.capabilities.testDraft(this.#configurationPlugin(state, draft.plugin), root, server, id);
      state.checks = { ...state.checks, [server]: { revision, result } };
      return result;
    } finally { state.busy = false; await this.#save(state); }
  }
  async installDraft(id: string, revision: string): Promise<PluginSetupState> {
    const state = await this.#loadState(id);
    if (state.busy) throw new Error("Wait for the builder to finish before installing");
    state.busy = true;
    let packageInstalled = false;
    try {
      const draft = await this.draft(id);
      if (draft.errors.length || !draft.plugin || !state.draftPath) throw new Error(draft.errors.join("\n") || "No valid plugin draft yet");
      if (draft.revision !== revision) throw new Error("The draft changed. Review it again before installing");
      const root = await pluginDraftPath(path.join(this.#directory(id), "workspace"), state.draftPath);
      const configurable = this.#configurationPlugin(state, draft.plugin);
      const plugin = await this.localPlugins.install(root);
      packageInstalled = true;
      state.pluginId = plugin.id;
      // Record the installed package before migrating configuration. A failed
      // migration must still expose uninstall and allow a retry after restart.
      await this.#save(state);
      if (configurable.id !== plugin.id) {
        await this.capabilities.configuration.promoteDraft(configurable, plugin);
        state.configurationId = plugin.id;
      }
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
          SETUP_PROMPT +
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
        "Native plugin operations. Actions: list, read (id), create-mcp (input: name,displayName,description,servers,configuration) prepares an uninstalled MCP draft, prepare (input: path) validates an authored directory and updates the preview, configure (id,input: values excluding secrets), definition (id,server), configure-server (id,server,input: complete MCP definition with configuration templates), test (id,server). Read includes configuration state and declared fields; secrets never appear. The user installs drafts from the builder.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("read"),
          Type.Literal("create-mcp"),
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
          let result: unknown;
          if (params.action === "list") result = await this.plugins.list();
          else if (params.action === "create-mcp") {
            const { manifest, servers } = mcpPluginPackage(params.input as CreateMcpPluginRequest);
            const source = path.join(cwd, manifest.name);
            await mkdir(path.join(source, ".ohmygame-plugin"), { recursive: true });
            await pluginDraftPath(cwd, source);
            await writeFile(path.join(source, ".ohmygame-plugin/plugin.json"), JSON.stringify(manifest, null, 2));
            await writeFile(path.join(source, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
            result = await this.prepare(state.id, source);
          } else if (params.action === "prepare") {
            const input = params.input as { path?: string } | undefined;
            if (!input?.path) throw new Error("Specify the plugin draft directory");
            result = await this.prepare(state.id, input.path);
          } else {
            const plugin = params.id
              ? await this.plugins.read(params.id)
              : undefined;
            if (!plugin) throw new Error("Plugin not found");
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
  const { id, pluginId, title, createdAt, updatedAt, status, model, reasoningLevel } = state;
  return { id, pluginId, title, createdAt, updatedAt, status, model, reasoningLevel };
}

export function registerPluginSetupRoutes(
  app: FastifyInstance,
  manager: PluginSetupManager,
) {
  app.get("/plugins/setup-sessions", () => manager.list());
  app.post<{ Body: { pluginId?: string } }>(
    "/plugins/setup-sessions",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { pluginId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply
          .code(201)
          .send(await manager.create(request.body?.pluginId));
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
  app.get<{ Params: { id: string } }>("/plugins/setup-sessions/:id/configuration", async (request, reply) => {
    try { return await manager.configuration(request.params.id); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
  });
  app.put<{ Params: { id: string }; Body: { values: PluginConfigurationValues } }>("/plugins/setup-sessions/:id/configuration", {
    schema: { body: { type: "object", required: ["values"], additionalProperties: false, properties: { values: {
      type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "boolean" }, { type: "null" }] },
    } } } },
  }, async (request, reply) => {
    try { return await manager.configuration(request.params.id, request.body.values); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
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
