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
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import {
  NEW_PLUGIN_TITLE,
  type PluginSetupSummary,
  type PluginDraft,
  type PluginIconUpdate,
  type PluginSetupMode,
} from "../shared/plugin-setup.js";
import type { ProjectState } from "../shared/contracts.js";
import type { McpServerDefinition, PluginMcpResult } from "../shared/plugins.js";
import { sessionDirectory } from "./conversations.js";
import type { PluginMcpHost } from "./plugin-mcp-host.js";
import type { PluginServices } from "./plugin-services.js";
import { inspectPluginDraft, inspectPluginFiles, pluginDraftPath, readPluginDraftFile } from "./plugin-draft.js";
import { isPluginIcon, PLUGIN_MANIFEST_PATH } from "../shared/plugins.js";
import { PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import { localizePluginString } from "./plugin-index.js";
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
};

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
        baseRevision: stored.baseRevision, checks: stored.checks,
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
      const project = this.projects.get(state.projectId);
      if (project) await this.projects.remove(project);
      const directory = this.#directory(id);
      const removed = `${directory}.removed-${randomUUID()}`;
      await rename(directory, removed);
      this.#states.delete(id);
      this.#writes.delete(id);
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
    const draft = await inspectPluginDraft(root, state.installedRevision);
    if (draft.plugin && state.pluginId && draft.plugin.id !== state.pluginId) {
      draft.errors.push(`This draft updates ${state.pluginId}, so it must keep that id`);
      draft.plugin = undefined;
    }
    return { ...draft, path: state.draftPath, checks: state.checks };
  }
  async prepare(id: string, requested: string): Promise<PluginDraft> {
    const state = await this.#loadState(id);
    const workspace = this.#workspace(id);
    const root = await pluginDraftPath(workspace, requested);
    state.draftPath = path.relative(workspace, root) || ".";
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
        "Omit id. This session works on its draft: list (installed plugins), read (the draft), read-skill (server: skill ID), prepare (input: path) validates files and refreshes the preview, test (server). Edit the draft's files and prepare again; users install drafts from the preview.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("read"),
          Type.Literal("read-skill"),
          Type.Literal("prepare"),
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
          if (params.id) throw new Error("This session works on its own draft; omit id");
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
  app.post<{ Params: { id: string; server: string }; Body: { revision: string } }>("/plugins/setup-sessions/:id/test/:server", {
    schema: { body: { type: "object", required: ["revision"], additionalProperties: false, properties: { revision: { type: "string", pattern: "^[0-9a-f]{64}$" } } } },
  }, async (request, reply) => {
    try { return await manager.testDraft(request.params.id, request.params.server, request.body.revision); }
    catch (cause) { return reply.code(400).send({ error: String(cause) }); }
  });
}
