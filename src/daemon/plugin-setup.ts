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
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import type {
  PluginSetupPrompt,
  PluginSetupState,
  PluginSetupMessage,
} from "../shared/plugin-setup.js";
import type {
  CreateMcpPluginRequest,
  InstallPluginRequest,
  PluginConfigurationValues,
} from "../shared/plugins.js";
import { compatibleRuntimeModel, lastAssistantError } from "./agent.js";
import type { RuntimeModel } from "./agent.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";
import type { PluginCatalogService } from "./plugin-catalog.js";
import type { LocalPluginStore } from "./local-plugins.js";
import { installPlugin } from "./plugin-installer.js";
import { openRouterAttributionExtension } from "./openrouter-attribution.js";

const SETUP_PROMPT = `You help users create, install, configure and repair native OhMyGame plugins. This is a dedicated plugin workspace, not a game project.
Use plugin_manage for structured operations. Call list/read before changing an existing plugin. A native package has .ohmygame-plugin/plugin.json with name (kebab-case), version (semver), description, optional skills (./skills), mcpServers (./mcp.json), configuration and interface. Each Skill is skills/<name>/SKILL.md with name/description frontmatter; supporting scripts/references/assets are allowed.
MCP files have {"mcpServers":{"server-id":{"command":"npx","args":["-y","existing-package"],"env":{"API_KEY":"\${config.api-key}"}}}} or {"url":"https://service/mcp"}. Declare configuration fields as {"api-key":{"type":"secret","label":"API key","required":true}}. Types: text, secret, path, boolean, select (options string[]), with label, description, required and default for nonsecret fields. Templates use \${config.field-id}. Do not hardcode secrets or ask users to paste secrets into chat. Use the configuration form and browser OAuth controls for credentials. You may configure nonsecret values, inspect status and test MCP. A test connects and lists tools without calling business tools. Report actual test results.
Use existing MCP servers; do not generate a new MCP server, Pi extension, hooks or custom plugin UI. Use bash/read/write/edit to author Skills and scripts in this workspace. For a new MCP-only plugin, use create-mcp. For a package you authored, use install with an absolute directory inside this workspace. Git installation supports HTTPS URLs. Installation is authorized by the user's request. Never modify credentials or session files. Preserve existing user configuration. Ask for essential service information when unavailable; don't invent endpoints or commands.
After operations explain what was installed, configured, what input is still required, and whether testing succeeded. Keep answers concise and match the user's language.`;

type SetupRuntimeState = Omit<PluginSetupState, "messages">;

export class PluginSetupManager {
  #states = new Map<string, SetupRuntimeState>();
  #history = new Map<string, SessionManager>();
  #writes = new Map<string, Promise<void>>();
  #sessions = new Map<string, AgentSession>();
  #closed = false;
  #runs = new Set<Promise<void>>();
  #aborted = new Set<string>();
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
    if (pluginId && !(await this.plugins.read(pluginId)))
      throw new Error("Plugin not found");
    const state: SetupRuntimeState = {
      id: randomUUID(),
      pluginId,
      busy: false,
    };
    this.#states.set(state.id, state);
    await mkdir(this.#directory(state.id), { recursive: true });
    await this.#save(state);
    return { ...state, messages: [] };
  }
  async read(id: string): Promise<PluginSetupState> {
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
        error: stored.error,
        busy: false,
      };
      // Keep the first concurrent reader's state so a prompt cannot be hidden
      // by another request loading the same session from disk.
      state = this.#states.get(id) ?? state;

      this.#states.set(id, state);
    }
    return { ...structuredClone(state), messages: this.#messages(id) };
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
  #messages(id: string): PluginSetupMessage[] {
    return this.#sessionManager(id)
      .getBranch()
      .flatMap((entry) => {
        if (entry.type !== "message") return [];
        const message = entry.message;
        if (message.role !== "user" && message.role !== "assistant") return [];
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        return text ? [{ role: message.role, text }] : [];
      });
  }
  async prompt(id: string, input: PluginSetupPrompt): Promise<void> {
    await this.read(id);
    const state = this.#states.get(id)!;
    if (state.busy) throw new Error("The plugin assistant is already working");
    if (this.#closed) throw new Error("Plugin assistant is closed");
    state.busy = true;
    this.#aborted.delete(id);
    state.error = undefined;
    // Track model lookup and initialization as part of the run, so close/abort
    // covers the entire operation rather than only the inference phase.
    const run = (async () => {
      const selected = await this.model(input.model);
      if (this.#closed || this.#aborted.has(id)) return;
      await this.#run(state, input.prompt, selected);
    })()
      .catch((cause) => {
        state.error = cause instanceof Error ? cause.message : String(cause);
      })
      .finally(async () => {
        state.busy = false;
        state.activity = undefined;
        await this.#save(state);
      });
    this.#runs.add(run);
    void run.finally(() => this.#runs.delete(run)).catch(() => {});
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
    if (this.#closed || this.#aborted.has(state.id)) {
      state.busy = false;
      session.dispose();
      this.#sessions.delete(state.id);
      return;
    }
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start")
        state.activity = event.toolName;
      if (event.type === "tool_execution_end") state.activity = undefined;
      if (event.type === "message_update") {
        const message = event.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
        };
        if (message.role === "assistant")
          state.activity =
            message.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join("")
              .slice(-4000) || state.activity;
      }
    });
    try {
      await session.prompt(prompt);
      state.error = lastAssistantError(session.messages);
    } finally {
      unsubscribe();
    }
  }

  #tool(cwd: string, state: SetupRuntimeState): ToolDefinition {
    return {
      name: "plugin_manage",
      label: "Manage plugin",
      description:
        "Native plugin operations. Actions: list, read (id), create-mcp (input: name,displayName,description,servers,configuration), install (input: type directory/path or git/url), configure (id,input: values excluding secrets), definition (id,server), configure-server (id,server,input: complete MCP definition with configuration templates), test (id,server). Read includes configuration state and declared fields; secrets never appear.",
      parameters: Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("read"),
          Type.Literal("create-mcp"),
          Type.Literal("install"),
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
            result = await this.capabilities.create(
              params.input as CreateMcpPluginRequest,
              false,
            );
            this.invalidate();
          } else if (params.action === "install") {
            const input = params.input as InstallPluginRequest;
            if (input.type === "directory") {
              const target = await realpath(input.path),
                root = await realpath(cwd);
              if (target !== root && !target.startsWith(root + path.sep))
                throw new Error(
                  "Author plugin files in this assistant's workspace",
                );
            }
            result = await installPlugin(this.localPlugins, input);
            this.invalidate();
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
          if (
            (params.action === "create-mcp" || params.action === "install") &&
            result &&
            typeof result === "object" &&
            "id" in result
          )
            state.pluginId = String(result.id);
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
    const contents = JSON.stringify({
      id: state.id,
      pluginId: state.pluginId,
      error: state.error,
    });
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
