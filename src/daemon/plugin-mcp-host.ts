import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type {
  McpServerDefinition,
  PluginMcpResult,
} from "../shared/plugins.js";

export interface McpStatus {
  name: string;
  status:
    | "connected"
    | "cached"
    | "failed"
    | "needs-auth"
    | "not-connected"
    | "disabled";
  toolCount: number;
}
export interface EffectiveMcpConfig {
  mcpServers: Record<string, McpServerDefinition>;
  settings?: Record<string, unknown>;
}
interface AdapterModule {
  createMcpAdapter(options: { config: EffectiveMcpConfig }): ExtensionFactory;
}
let adapterModule: Promise<AdapterModule> | undefined;
function adapter(): Promise<AdapterModule> {
  return (adapterModule ??= createJiti(import.meta.url).import(
    createRequire(import.meta.url).resolve("pi-mcp-adapter"),
  ) as Promise<AdapterModule>);
}

/** All game sessions and temporary probes use the same adapter and explicit
 * resolved configuration. Ambient mcp.json files never bypass plugin settings. */
export class PluginMcpHost {
  #runtimes = new Map<string, Map<string, McpStatus>>();
  #cleanup = new Set<() => Promise<void>>();
  #auth = new Map<
    string,
    {
      session: AgentSession;
      close: () => Promise<void>;
      timer: NodeJS.Timeout;
      signature: string;
    }
  >();
  #operations = new Map<string, Promise<PluginMcpResult>>();
  #closed = false;
  async extension(
    config: EffectiveMcpConfig,
    publishStatus = true,
  ): Promise<ExtensionFactory> {
    const factory = (await adapter()).createMcpAdapter({
      config: {
        ...config,
        settings: { ...config.settings, hostConfigDiscovery: "off" },
      },
    });
    return async (pi) => {
      if (this.#closed) throw new Error("MCP host is closed");
      const id = randomUUID(),
        statuses = new Map<string, McpStatus>();
      if (publishStatus) this.#runtimes.set(id, statuses);
      const unsubscribe = pi.events.on(
        "pi-mcp-adapter/status/v1",
        (value: unknown) => {
          const snapshot = value as { servers?: McpStatus[] };
          if (!Array.isArray(snapshot.servers)) return;
          statuses.clear();
          for (const status of snapshot.servers)
            statuses.set(status.name, status);
        },
      );
      pi.on("session_shutdown", () => {
        unsubscribe();
        this.#runtimes.delete(id);
      });
      try {
        await factory(pi);
      } catch (cause) {
        unsubscribe();
        this.#runtimes.delete(id);
        throw cause;
      }
    };
  }
  status(name: string): McpStatus | undefined {
    const entries = [...this.#runtimes.values()].flatMap(
      (statuses) => statuses.get(name) ?? [],
    );
    return (
      entries.find((s) => s.status === "connected") ??
      entries.find((s) => s.status === "needs-auth") ??
      entries.at(-1)
    );
  }
  manage(session: AgentSession): () => Promise<void> {
    const dispose = session.dispose.bind(session);
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        try {
          await session.abort();
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        } finally {
          dispose();
          this.#cleanup.delete(close);
        }
      })());
    this.#cleanup.add(close);
    session.dispose = () => {
      void close().catch(() => {});
    };
    return close;
  }
  async probe(
    key: string,
    name: string,
    definition: McpServerDefinition,
    agentDir: string,
    action: "test" | "auth-start" | "auth-complete",
    input?: string,
  ): Promise<PluginMcpResult> {
    if (this.#closed) throw new Error("MCP host is closed");
    const operation = (this.#operations.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.#probe(key, name, definition, agentDir, action, input));
    this.#operations.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#operations.get(key) === operation) this.#operations.delete(key);
    }
  }
  async #probe(
    key: string,
    name: string,
    definition: McpServerDefinition,
    agentDir: string,
    action: "test" | "auth-start" | "auth-complete",
    input?: string,
  ): Promise<PluginMcpResult> {
    if (this.#closed) throw new Error("MCP host is closed");
    const signature = createHash("sha256")
      .update(JSON.stringify(definition))
      .digest("hex");
    let runtime = this.#auth.get(key);
    if (
      action === "auth-complete" &&
      runtime &&
      runtime.signature !== signature
    ) {
      clearTimeout(runtime.timer);
      this.#auth.delete(key);
      await runtime.close();
      throw new Error("MCP configuration changed. Start authorization again.");
    }
    if (action === "auth-complete" && !runtime)
      throw new Error("Authorization expired. Start authorization again.");
    if (action !== "auth-complete") {
      if (runtime) {
        clearTimeout(runtime.timer);
        this.#auth.delete(key);
        await runtime.close();
      }
      const config = {
        mcpServers: {
          [name]: {
            ...definition,
            disabled: false,
            lifecycle: "lazy",
            directTools: false,
            requestTimeoutMs: 20_000,
          },
        },
      };
      const settingsManager = SettingsManager.inMemory({ packages: [] });
      const resourceLoader = new DefaultResourceLoader({
        cwd: agentDir,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          { name: "plugin-mcp", factory: await this.extension(config, false) },
        ],
      });
      await resourceLoader.reload();
      if (resourceLoader.getExtensions().errors.length)
        throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
      const { session } = await createAgentSession({
        cwd: agentDir,
        agentDir,
        settingsManager,
        resourceLoader,
        noTools: "builtin",
        sessionManager: SessionManager.inMemory(agentDir),
      });
      const close = this.manage(session);
      if (this.#closed) {
        await close();
        throw new Error("MCP host is closed");
      }
      try {
        await session.bindExtensions({ mode: "rpc" });
      } catch (cause) {
        await close();
        throw cause;
      }
      const timer = setTimeout(() => {
        this.#auth.delete(key);
        void close().catch(() => {});
      }, 10 * 60_000);
      timer.unref();
      runtime = { session, close, timer, signature };
    }
    if (!runtime) throw new Error("MCP runtime unavailable");
    let keep = false;
    try {
      const tool = runtime.session.getToolDefinition("mcp");
      if (!tool) throw new Error("MCP adapter failed to load");
      const params =
        action === "test"
          ? { connect: name }
          : { action, server: name, ...(input ? { args: { input } } : {}) };
      const result = await tool.execute(
        randomUUID(),
        params,
        AbortSignal.timeout(30_000),
        undefined,
        runtime.session.extensionRunner.createToolContext(
          "plugin-probe",
          undefined,
        ),
      );
      const details = (result.details ?? {}) as Record<string, unknown>;
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const url =
        typeof details.authorizationUrl === "string"
          ? details.authorizationUrl
          : undefined;
      if (url) {
        keep = true;
        this.#auth.set(key, runtime);
        return { status: "needs-auth", toolCount: 0, authorizationUrl: url };
      }
      // Query machine status after connecting instead of interpreting display text.
      const statusResult = await tool.execute(
        randomUUID(),
        {},
        AbortSignal.timeout(5_000),
        undefined,
        runtime.session.extensionRunner.createToolContext(
          "plugin-probe",
          undefined,
        ),
      );
      const statusDetails = statusResult.details as
        { servers?: McpStatus[] } | undefined;
      const server = statusDetails?.servers?.find((s) => s.name === name);
      const authRequired =
        server?.status === "needs-auth" ||
        details.error === "needs_auth" ||
        details.error === "auth_required";
      return {
        status:
          details.authenticated === true || server?.status === "connected"
            ? "connected"
            : authRequired
              ? "needs-auth"
              : "failed",
        toolCount: server?.toolCount ?? 0,
        message: text.slice(0, 4000),
      };
    } finally {
      if (!keep) {
        clearTimeout(runtime.timer);
        this.#auth.delete(key);
        await runtime.close();
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const runtime of this.#auth.values()) clearTimeout(runtime.timer);
    this.#auth.clear();
    await Promise.allSettled([...this.#cleanup].map((close) => close()));
    await Promise.allSettled([...this.#operations.values()]);
  }
}
