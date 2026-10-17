import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentModel } from "../../shared/contracts.js";
import {
  AGENT_RUNTIME_IDS,
  type AgentRuntimeDiagnostic,
  type AgentRuntimeId,
  type AgentRuntimeLoginResponse,
  type AgentRuntimeStatus,
  type ApprovalDecision,
  type ApprovalRequestDetails,
  type UpdateAgentRuntimeRequest,
} from "../../shared/agent-runtimes.js";
import type { SkillCatalogItem } from "../agent.js";
import type { EffectiveMcpConfig, PluginMcpHost } from "../plugin-mcp-host.js";
import { AGENT_RUNTIME_DEFINITIONS, versionAtLeast } from "./definitions.js";
import {
  privateFolder,
  probeAuth,
  probeModels,
  probeVersion,
  resolveBinary,
  type AuthProbe,
} from "./discovery.js";
import { agentEnvironment, loginShellPath } from "./environment.js";
import { AgentProcess, stopAgentProcesses } from "./process.js";
import {
  recoverAgentProcesses,
  recoverAgentDirectories,
} from "./process-recovery.js";
import { NativeCodingSession, type NativeDriver } from "./native-session.js";
import { ToolBridge } from "./tool-bridge.js";
import type { DriverContext, HttpBridgeHandlers } from "./driver-context.js";
import type { AgentPolicyContext } from "./policy.js";
import { AgentRuntimeSettingsStore } from "./settings.js";
import { stagedSkillsRoot } from "./skills.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { CodexAppServer, CodexDriver } from "./codex.js";
import { OpenCodeDriver } from "./opencode.js";

const STATUS_TTL_MS = 60_000;

/**
 * Coding agents see OhMyGame's tools under their CLI's MCP names and follow
 * their own planning habits, such as plan files; Pi needs neither line.
 */
const NATIVE_INSTRUCTIONS =
  "OhMyGame's own tools (canvas checks, image, video, 3D and audio generation, game playtesting, questionnaire, update_plan and plugin services) come from its ohmygame tool server; your CLI may name them with a prefix such as mcp__ohmygame__ or ohmygame_. In a planning turn, record the plan with update_plan before you finish, rather than writing a plan file or only describing it.";
const MODELS_TTL_MS = 10 * 60_000;
const MODELS_WAIT_MS = 6_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface ProbeCache {
  signature: string;
  version?: string;
  auth: AuthProbe;
  diagnostics: AgentRuntimeDiagnostic[];
  checkedAt: number;
}

export interface NativeSessionRequest {
  runtime: AgentRuntimeId;
  model: string;
  reasoningLevel?: string;
  contextWindow?: number;
  workspacePath: string;
  sessionManager: SessionManager;
  /** OhMyGame's tools for the project, as Pi gets them. */
  tools: ToolDefinition[];
  pluginMcp?: {
    config: EffectiveMcpConfig;
    host: PluginMcpHost;
    agentDir: string;
  };
  skillDirectories: string[];
  instructions: string;
  policy: AgentPolicyContext;
  snapshotBeforeMessage?: () => Promise<string>;
  turnNotice?: () => Promise<string | undefined>;
  requestApproval(
    details: ApprovalRequestDetails,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
  skills?: () => SkillCatalogItem[];
}

/**
 * The coding agents OhMyGame can run conversations with. Nothing here runs
 * until something asks: choosing OhMyGame's own agent never starts or probes
 * a CLI, and a slow or broken CLI only delays its own status and models.
 */
export class AgentRuntimeService {
  readonly settings: AgentRuntimeSettingsStore;
  #revisions = new Map<AgentRuntimeId, number>();
  #probes = new Map<AgentRuntimeId, ProbeCache>();
  #probing = new Map<AgentRuntimeId, Promise<ProbeCache | undefined>>();
  #models = new Map<
    AgentRuntimeId,
    { signature: string; models: AgentModel[]; at: number }
  >();
  #modelLoads = new Map<AgentRuntimeId, Promise<AgentModel[]>>();
  #bridges = new Map<
    string,
    { bridge: ToolBridge; handlers: HttpBridgeHandlers }
  >();
  #modelErrors = new Map<AgentRuntimeId, string>();
  readonly #root: string;

  constructor(
    dataDirectory: string,
    private readonly bridgeUrl: () => string | undefined,
  ) {
    this.settings = new AgentRuntimeSettingsStore(dataDirectory);
    this.#root = path.join(dataDirectory, "agent-runtimes");
  }

  async load(): Promise<void> {
    await this.settings.load();
    await recoverAgentProcesses(path.join(this.#root, "processes"));
    await recoverAgentDirectories(path.join(this.#root, "sessions"));
    await recoverAgentDirectories(path.join(this.#root, "probes"));
  }

  async statuses(recheck = false): Promise<AgentRuntimeStatus[]> {
    return Promise.all(AGENT_RUNTIME_IDS.map((id) => this.status(id, recheck)));
  }

  async status(
    id: AgentRuntimeId,
    recheck = false,
  ): Promise<AgentRuntimeStatus> {
    if (recheck) this.#invalidate(id);
    const definition = AGENT_RUNTIME_DEFINITIONS[id];
    const settings = this.settings.get(id);
    const binary = await resolveBinary(id, settings.binaryPath, recheck);
    const base = {
      id,
      name: definition.name,
      enabled: settings.enabled,
      isolateUserConfig: settings.isolateUserConfig,
      ...(id === "codex-cli" && settings.isolateUserConfig
        ? { partialIsolation: true }
        : {}),
    };
    if (!binary) {
      return {
        ...base,
        installed: false,
        auth: { status: "unknown", billing: "unknown" },
        diagnostics: [
          {
            code: "not-installed",
            message: `${definition.name} was not found on PATH or in the usual install folders`,
            command: definition.installUrl,
          },
        ],
      };
    }
    const probe = await this.#probe(id, binary, recheck);
    return {
      ...base,
      installed: true,
      binaryPath: binary.path,
      ...(probe?.version ? { version: probe.version } : {}),
      auth: probe
        ? {
            status: probe.auth.status,
            billing: probe.auth.billing,
            ...(probe.auth.account ? { account: probe.auth.account } : {}),
          }
        : { status: "unknown", billing: "unknown" },
      diagnostics: [
        ...(probe?.diagnostics ?? [
          {
            code: "probe-failed",
            message: `${definition.name} did not answer`,
          },
        ]),
        ...(this.#modelErrors.has(id)
          ? [
              {
                code: "models-unavailable" as const,
                message: this.#modelErrors.get(id)!,
              },
            ]
          : []),
      ],
      ...(probe ? { checkedAt: new Date(probe.checkedAt).toISOString() } : {}),
    };
  }

  async update(
    id: AgentRuntimeId,
    request: UpdateAgentRuntimeRequest,
  ): Promise<AgentRuntimeStatus> {
    if (
      request.binaryPath !== undefined &&
      request.binaryPath !== "" &&
      !path.isAbsolute(request.binaryPath)
    )
      throw new Error("The executable path must be absolute");
    if (request.binaryPath && /\.(?:cmd|bat)$/i.test(request.binaryPath))
      throw new Error(
        "Choose the program itself (.exe); Windows command scripts cannot be started directly",
      );
    await this.settings.update(id, {
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.isolateUserConfig !== undefined
        ? { isolateUserConfig: request.isolateUserConfig }
        : {}),
      ...(request.binaryPath !== undefined
        ? { binaryPath: request.binaryPath }
        : {}),
    });
    this.#invalidate(id);
    return this.status(id, request.binaryPath !== undefined);
  }

  /** Models of the enabled agents that are installed. One that is slow to answer is left out this time, not waited for. */
  async models(): Promise<{ models: AgentModel[]; loading: AgentRuntimeId[] }> {
    const loading: AgentRuntimeId[] = [];
    const lists = await Promise.all(
      AGENT_RUNTIME_IDS.map(async (id) => {
        if (!this.settings.get(id).enabled) return [];
        const cached = this.#models.get(id);
        if (cached && Date.now() - cached.at < MODELS_TTL_MS)
          return cached.models;
        const load = this.#loadModels(id).catch(() => [] as AgentModel[]);
        const late = Symbol("late");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          load,
          new Promise<typeof late>((resolve) => {
            timer = setTimeout(() => resolve(late), MODELS_WAIT_MS);
          }),
        ]).finally(() => clearTimeout(timer));
        if (result !== late) return result;
        loading.push(id);
        return [];
      }),
    );
    return { models: lists.flat(), loading };
  }

  async model(
    id: AgentRuntimeId,
    modelId: string,
  ): Promise<AgentModel | undefined> {
    if (!this.settings.get(id).enabled) return undefined;
    const models = await this.#loadModels(id).catch(() => []);
    return models.find((model) => model.id === modelId);
  }

  /** Starts the CLI's own sign-in. A browser page comes back when the CLI hands one out; otherwise the command to run. */
  async login(id: AgentRuntimeId): Promise<AgentRuntimeLoginResponse> {
    const definition = AGENT_RUNTIME_DEFINITIONS[id];
    const binary = await resolveBinary(id, this.settings.get(id).binaryPath);
    if (!binary) throw new Error(`${definition.name} is not installed`);
    const env = await this.#environment(id, binary.path);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const forget = () => this.#invalidate(id);
    if (id === "codex-cli") {
      const server = new CodexAppServer(binary.path, this.#root, env, {
        notification: (method) => {
          if (method !== "account/login/completed") return;
          forget();
          void server.stop();
        },
      });
      setTimeout(() => {
        void server.stop();
      }, LOGIN_TIMEOUT_MS).unref();
      try {
        await server.initialize();
        const started = await server.request<{ authUrl?: unknown }>(
          "account/login/start",
          { type: "chatgpt" },
        );
        return typeof started.authUrl === "string"
          ? { url: started.authUrl }
          : { command: definition.loginCommand };
      } catch (cause) {
        await server.stop();
        throw cause;
      }
    }
    if (id === "claude-code-cli") {
      return new Promise((resolve) => {
        let found = false;
        const child = new AgentProcess({
          binaryPath: binary.path,
          args: ["auth", "login", "--claudeai"],
          cwd: this.#root,
          env,
          onLine: (line) => {
            const url = line.match(/https:\/\/\S+/)?.[0];
            if (!url || found) return;
            found = true;
            resolve({ url });
          },
          onExit: () => {
            forget();
            if (!found) resolve({ command: definition.loginCommand });
          },
        });
        setTimeout(() => {
          if (!found) {
            found = true;
            resolve({ command: definition.loginCommand });
          }
        }, 15_000).unref();
        setTimeout(() => {
          void child.stop();
        }, LOGIN_TIMEOUT_MS).unref();
      });
    }
    return { command: definition.loginCommand };
  }

  async createSession(
    request: NativeSessionRequest,
  ): Promise<NativeCodingSession> {
    const settings = this.settings.get(request.runtime);
    const definition = AGENT_RUNTIME_DEFINITIONS[request.runtime];
    if (!settings.enabled)
      throw new Error(
        `${definition.name} is turned off. Turn it on in Providers & Models to continue.`,
      );
    const binary = await resolveBinary(request.runtime, settings.binaryPath);
    if (!binary)
      throw new Error(
        `${definition.name} is not installed. Install it, then check again in Providers & Models.`,
      );
    const probe = await this.#probe(request.runtime, binary, false);
    const blocking = probe?.diagnostics.find(
      (diagnostic) => diagnostic.code === "version-unsupported",
    );
    if (blocking) throw new Error(blocking.message);
    await mkdir(path.join(this.#root, "sessions"), {
      recursive: true,
      mode: 0o700,
    });
    const folder = await privateFolder(
      path.join(this.#root, "sessions"),
      request.runtime,
    );
    let pluginTool:
      { tool: ToolDefinition; close: () => Promise<void> } | undefined;
    try {
      if (
        request.pluginMcp &&
        Object.keys(request.pluginMcp.config.mcpServers).length
      ) {
        pluginTool = await request.pluginMcp.host.tool(
          request.pluginMcp.config,
          request.pluginMcp.agentDir,
        );
      }
    } catch {
      // Plugin servers that cannot start leave the agent without them, as a failed MCP server does in Pi.
      pluginTool = undefined;
    }
    const bridge = new ToolBridge([
      ...request.tools,
      ...(pluginTool ? [pluginTool.tool] : []),
    ]);
    const env = await this.#environment(request.runtime, binary.path);
    const revoke = new Set<() => void>();
    const context = (
      resume: string | undefined,
      model: string,
      reasoningLevel: string | undefined,
    ): DriverContext => ({
      binaryPath: binary.path,
      workspacePath: request.workspacePath,
      env,
      privateDirectory: folder.path,
      processDirectory: path.join(this.#root, "processes"),
      isolateUserConfig: settings.isolateUserConfig,
      instructions: `${request.instructions}\n\n${NATIVE_INSTRUCTIONS}`,
      bridge,
      policy: {
        ...request.policy,
        readablePaths: [stagedSkillsRoot(request.runtime, folder.path)],
      },
      skillDirectories: request.skillDirectories,
      httpBridge: async (handlers) => {
        const registered = this.#registerBridge(bridge, handlers);
        const stop = () => {
          registered.revoke();
          revoke.delete(stop);
        };
        revoke.add(stop);
        handlers.signal.addEventListener("abort", () => revoke.delete(stop), {
          once: true,
        });
        return { ...registered, revoke: stop };
      },
      model,
      ...(request.contextWindow
        ? { contextWindow: request.contextWindow }
        : {}),
      ...(reasoningLevel ? { reasoningLevel } : {}),
      ...(resume ? { resume } : {}),
    });
    const createDriver = (
      resume: string | undefined,
      current: { model: string; reasoningLevel?: string },
    ): NativeDriver => {
      const driverContext = context(
        resume,
        current.model,
        current.reasoningLevel,
      );
      if (request.runtime === "claude-code-cli")
        return new ClaudeCodeDriver(driverContext);
      if (request.runtime === "codex-cli")
        return new CodexDriver(driverContext);
      return new OpenCodeDriver(driverContext);
    };
    return new NativeCodingSession({
      runtime: request.runtime,
      model: request.model,
      ...(request.reasoningLevel
        ? { nativeReasoningLevel: request.reasoningLevel }
        : {}),
      sessionManager: request.sessionManager,
      createDriver,
      ...(request.snapshotBeforeMessage
        ? { snapshotBeforeMessage: request.snapshotBeforeMessage }
        : {}),
      ...(request.turnNotice ? { turnNotice: request.turnNotice } : {}),
      requestApproval: request.requestApproval,
      toolNames: bridge.names,
      setActiveTools: (names) => bridge.setActive(names),
      ...(request.skills ? { skills: request.skills } : {}),
      dispose: async () => {
        for (const stop of revoke) stop();
        await pluginTool?.close().catch(() => {});
        await folder.remove();
      },
    });
  }

  /**
   * Answers an MCP request that came in over HTTP with a session's token.
   * The token is compared in constant time and works only while a turn of
   * that conversation runs; outside one, every call is refused.
   */
  async handleBridgeRequest(
    authorization: string | undefined,
    body: unknown,
  ): Promise<{ status: number; body?: unknown }> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const entry = token ? this.#bridgeFor(token) : undefined;
    if (!entry)
      return {
        status: 401,
        body: { error: "Unknown or revoked bridge token" },
      };
    const messages = Array.isArray(body) ? body : [body];
    const answers: unknown[] = [];
    for (const message of messages) {
      const method =
        message && typeof message === "object"
          ? (message as { method?: unknown }).method
          : undefined;
      if (
        method === "tools/call" &&
        (!entry.handlers.active() || entry.handlers.signal.aborted)
      ) {
        const id = (message as { id?: unknown }).id;
        answers.push({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32001,
            message: "No turn of this conversation is running",
          },
        });
        continue;
      }
      const answer = await entry.bridge.handle(
        message,
        (call, outcome) => {
          if (!entry.handlers.signal.aborted && entry.handlers.active())
            entry.handlers.observe(call, outcome);
        },
        entry.handlers.signal,
      );
      if (answer) answers.push(answer);
    }
    if (!answers.length) return { status: 202 };
    return { status: 200, body: Array.isArray(body) ? answers : answers[0] };
  }

  /** Stops every CLI still running: sessions let go of theirs without waiting, sign-ins may still be open. */
  async close(): Promise<void> {
    this.#bridges.clear();
    await stopAgentProcesses();
  }

  #registerBridge(
    bridge: ToolBridge,
    handlers: HttpBridgeHandlers,
  ): { url: string; token: string; revoke: () => void } {
    const base = this.bridgeUrl();
    if (!base) throw new Error("The daemon address is not known yet");
    const token = randomBytes(32).toString("base64url");
    this.#bridges.set(token, { bridge, handlers });
    const revoke = () => {
      this.#bridges.delete(token);
      handlers.signal.removeEventListener("abort", revoke);
    };
    if (handlers.signal.aborted) revoke();
    else handlers.signal.addEventListener("abort", revoke, { once: true });
    return {
      url: `${base}/agent-runtime-bridge/mcp`,
      token,
      revoke,
    };
  }

  #bridgeFor(
    token: string,
  ): { bridge: ToolBridge; handlers: HttpBridgeHandlers } | undefined {
    const presented = Buffer.from(token);
    for (const [candidate, entry] of this.#bridges) {
      const expected = Buffer.from(candidate);
      if (
        expected.length === presented.length &&
        timingSafeEqual(expected, presented)
      )
        return entry;
    }
    return undefined;
  }

  #invalidate(id: AgentRuntimeId): void {
    this.#revisions.set(id, (this.#revisions.get(id) ?? 0) + 1);
    this.#probes.delete(id);
    this.#models.delete(id);
    this.#modelErrors.delete(id);
    this.#probing.delete(id);
    this.#modelLoads.delete(id);
  }

  async #environment(
    id: AgentRuntimeId,
    binaryPath: string,
  ): Promise<Record<string, string>> {
    return agentEnvironment(
      id,
      binaryPath,
      {},
      process.env,
      await loginShellPath(),
    );
  }

  async #probe(
    id: AgentRuntimeId,
    binary: { path: string; signature: string },
    recheck: boolean,
  ): Promise<ProbeCache | undefined> {
    const cached = this.#probes.get(id);
    if (
      !recheck &&
      cached?.signature === binary.signature &&
      Date.now() - cached.checkedAt < STATUS_TTL_MS
    )
      return cached;
    const running = this.#probing.get(id);
    if (running) return running;
    const revision = this.#revisions.get(id);
    const work = (async () => {
      const definition = AGENT_RUNTIME_DEFINITIONS[id];
      const env = await this.#environment(id, binary.path);
      const diagnostics: AgentRuntimeDiagnostic[] = [];
      let version: string | undefined;
      let auth: AuthProbe = { status: "unknown", billing: "unknown" };
      try {
        [version, auth] = await Promise.all([
          probeVersion(binary.path, id, env),
          probeAuth(binary.path, id, env),
        ]);
      } catch (cause) {
        diagnostics.push({
          code: "probe-failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
      if (version && !versionAtLeast(version, definition.minimumVersion)) {
        diagnostics.push({
          code: "version-unsupported",
          message: `${definition.name} ${version} is older than ${definition.minimumVersion}, the oldest version OhMyGame supports. Update it to continue.`,
        });
      }
      if (auth.status === "signed-out")
        diagnostics.push({
          code: "signed-out",
          message: `${definition.name} is not signed in`,
          command: definition.loginCommand,
        });
      const result: ProbeCache = {
        signature: binary.signature,
        ...(version ? { version } : {}),
        auth,
        diagnostics,
        checkedAt: Date.now(),
      };
      if (this.#revisions.get(id) === revision) this.#probes.set(id, result);
      return result;
    })().finally(() => {
      if (this.#probing.get(id) === work) this.#probing.delete(id);
    });
    this.#probing.set(id, work);
    return work;
  }

  #loadModels(id: AgentRuntimeId): Promise<AgentModel[]> {
    const running = this.#modelLoads.get(id);
    if (running) return running;
    const revision = this.#revisions.get(id);
    const work = (async () => {
      const settings = this.settings.get(id);
      const binary = await resolveBinary(id, settings.binaryPath);
      if (!binary) return [];
      const cached = this.#models.get(id);
      if (
        cached?.signature === binary.signature &&
        Date.now() - cached.at < MODELS_TTL_MS
      )
        return cached.models;
      const env = await this.#environment(id, binary.path);
      await mkdir(path.join(this.#root, "probes"), {
        recursive: true,
        mode: 0o700,
      });
      const folder = await privateFolder(path.join(this.#root, "probes"), id);
      try {
        const { models, account } = await probeModels(
          binary.path,
          id,
          env,
          folder.path,
          settings.isolateUserConfig,
        );
        if (this.#revisions.get(id) !== revision) return [];
        this.#models.set(id, {
          signature: binary.signature,
          models,
          at: Date.now(),
        });
        this.#modelErrors.delete(id);
        if (!models.length)
          this.#modelErrors.set(
            id,
            `${AGENT_RUNTIME_DEFINITIONS[id].name} returned an empty model catalog. Check sign-in and CLI protocol support.`,
          );
        const probe = this.#probes.get(id);
        if (account && probe && !probe.auth.account)
          probe.auth = { ...probe.auth, account };
        return models;
      } catch (cause) {
        if (this.#revisions.get(id) === revision)
          this.#modelErrors.set(
            id,
            cause instanceof Error ? cause.message : String(cause),
          );
        throw cause;
      } finally {
        await folder.remove();
      }
    })().finally(() => {
      if (this.#modelLoads.get(id) === work) this.#modelLoads.delete(id);
    });
    this.#modelLoads.set(id, work);
    return work;
  }
}
