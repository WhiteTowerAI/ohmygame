import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, stat, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentModel, AgentUsageLimit } from "../../shared/contracts.js";
import {
  ACCOUNT_RUNTIME_IDS,
  AGENT_RUNTIME_IDS,
  isAccountRuntimeId,
  isAgentRuntimeId,
  type AccountRuntimeId,
  type AccountProfileIds,
  type AgentRuntimeDiagnostic,
  type AgentRuntimeId,
  type AgentRuntimeLoginResponse,
  type AgentRuntimeStatus,
  type ApprovalDecision,
  type ApprovalRequestDetails,
  type UpdateAgentRuntimeRequest,
  type AgentAccountProfileStatus,
} from "../../shared/agent-runtimes.js";
import type { SkillCatalogItem } from "../agent.js";
import type { EffectiveMcpConfig, PluginMcpHost } from "../plugin-mcp-host.js";
import { AGENT_RUNTIME_DEFINITIONS, commandSandbox } from "./definitions.js";
import {
  AgentRuntimeCompatibilityError,
  checkRuntimeVersionRequirement,
  runtimeStartupError,
} from "./compatibility.js";
import {
  privateFolder,
  isCodexNpmShim,
  probeAuth,
  probeModels,
  probeVersion,
  resolveBinary,
  runCli,
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
import type { DriverContext, HttpBridgeHandlers, SaveGeneratedImage } from "./driver-context.js";
import type { AgentPolicyContext } from "./policy.js";
import { AgentRuntimeSettingsStore } from "./settings.js";
import { stagedSkillsRoot } from "./skills.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { CodexAppServer } from "./codex-app-server.js";
import { CodexDriver } from "./codex.js";
import { codexServerIdentity } from "./codex-server-pool.js";
import { OpenCodeDriver } from "./opencode.js";

const STATUS_TTL_MS = 60_000;

/**
 * Coding agents see OhMyGame's tools under their CLI's MCP names and follow
 * their own planning habits, such as plan files; Pi needs neither line.
 */
const NATIVE_INSTRUCTIONS =
  "OhMyGame's own tools (canvas checks, image, video, 3D and audio generation, game playtesting, questionnaire, update_plan and plugin services) come from its ohmygame tool server; your CLI may name them with a prefix such as mcp__ohmygame__ or ohmygame_. In a planning turn, record the plan with update_plan before you finish, rather than writing a plan file or only describing it. The Skills your CLI lists are readable where it lists them, even outside the workspace: read a Skill's files directly when a request calls for it.";
const MODELS_TTL_MS = 10 * 60_000;
const MODELS_WAIT_MS = 6_000;

/** A catalog load's result, or undefined when it is still loading after MODELS_WAIT_MS. */
async function withinModelsWait<T>(load: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    load,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), MODELS_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}
const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface ProbeCache {
  signature: string;
  version?: string;
  auth: AuthProbe;
  diagnostics: AgentRuntimeDiagnostic[];
  checkedAt: number;
  requirementError?: Error;
}

export interface NativeSessionRequest {
  profileId?: string;
  runtime: AgentRuntimeId;
  model: string;
  reasoningLevel?: string;
  contextWindow?: number;
  workspacePath: string;
  sessionManager: SessionManager;
  /** OhMyGame's tools for the project, as Pi gets them. */
  tools: ToolDefinition[];
  saveGeneratedImage?: SaveGeneratedImage;
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
 * until something asks. Conversation model discovery only probes enabled
 * agents; the image catalog can independently probe Codex for media use.
 * A slow or broken CLI only delays its own status and models.
 */
export class AgentRuntimeService {
  readonly settings: AgentRuntimeSettingsStore;
  #revisions = new Map<string, number>();
  #probes = new Map<string, ProbeCache>();
  #probing = new Map<string, Promise<ProbeCache | undefined>>();
  #models = new Map<
    string,
    { signature: string; models: AgentModel[]; at: number }
  >();
  #modelLoads = new Map<string, Promise<AgentModel[]>>();
  #bridges = new Map<
    string,
    { bridge: ToolBridge; handlers: HttpBridgeHandlers }
  >();
  #modelErrors = new Map<
    string,
    {
      signature: string;
      at: number;
      diagnostic: AgentRuntimeDiagnostic;
      cause?: Error;
    }
  >();
  /** Each account's quota windows as last reported; they outlive the conversation that reported them. */
  #limits = new Map<string, AgentUsageLimit[]>();
  #deleting = new Set<string>();
  #logins = new Map<string, () => Promise<void>>();
  #limitWrites: Promise<void> = Promise.resolve();
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
    try {
      const stored = JSON.parse(
        await readFile(path.join(this.#root, "limits.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const [id, limits] of Object.entries(stored))
        if ((isAgentRuntimeId(id) || ACCOUNT_RUNTIME_IDS.some((runtime) => id.startsWith(`${runtime}:`))) && Array.isArray(limits))
          this.#limits.set(id, limits.filter(isUsageLimit));
    } catch {
      // No limits reported yet, or a damaged file: they arrive with the next report.
    }
  }

  /** Keeps the latest quota windows across restarts, since Claude Code reports them only during a conversation. */
  #recordLimits(id: string, limits: AgentUsageLimit[]): void {
    this.#limits.set(id, limits);
    this.#recordLimitsCache();
  }

  #recordLimitsCache(): void {
    this.#limitWrites = this.#limitWrites
      .then(async () => {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(this.#root, "limits.json"),
          `${JSON.stringify(Object.fromEntries(this.#limits))}\n`,
        );
      })
      .catch(() => {});
  }

  async statuses(recheck = false): Promise<AgentRuntimeStatus[]> {
    return Promise.all(AGENT_RUNTIME_IDS.map((id) => this.status(id, recheck)));
  }

  /** Media can use Codex's sign-in without enabling it as a conversation agent. */
  async codexImageConnection(recheck = false) {
    const binary = await resolveBinary("codex-cli", this.settings.get("codex-cli").binaryPath, recheck);
    if (!binary) return undefined;
    const probe = await this.#probe("codex-cli", binary, recheck, "system");
    return {
      ...binary,
      env: await this.#environment("codex-cli", binary.path, "system"),
      auth: probe?.auth,
      error: probe?.requirementError?.message,
    };
  }

  async status(
    id: AgentRuntimeId,
    recheck = false,
    profileId?: string,
  ): Promise<AgentRuntimeStatus> {
    profileId = isAccountRuntimeId(id) ? this.#profileId(id, profileId) : undefined;
    const cacheKey = this.#key(id, profileId);
    if (recheck) this.#invalidate(id);
    const revision = this.#revisions.get(cacheKey);
    const definition = AGENT_RUNTIME_DEFINITIONS[id];
    const settings = this.settings.get(id);
    const binary = await resolveBinary(id, settings.binaryPath, recheck);
    if (this.#revisions.get(cacheKey) !== revision) return this.status(id, false, profileId);
    const limits = this.#limits.get(cacheKey);
    const base = {
      id,
      name: definition.name,
      testedVersion: definition.testedVersion,
      enabled: settings.enabled,
      commandSandbox: commandSandbox(id),
      permissionMode: settings.permissionMode,
      ...(isAccountRuntimeId(id) ? { defaultProfileId: settings.defaultProfileId ?? "system" } : {}),
      ...(settings.binaryPath
        ? { configuredBinaryPath: settings.binaryPath }
        : {}),
      ...(limits?.length ? { limits } : {}),
    };
    if (!binary) {
      return {
        ...base,
        installed: false,
        auth: { status: "unknown", billing: "unknown" },
        diagnostics: [
          {
            code: settings.binaryPath ? "invalid-executable" : "not-installed",
            message: settings.binaryPath
              ? `The configured executable is missing or not executable: ${settings.binaryPath}`
              : `${definition.name} was not found on PATH or in the usual install folders`,
            ...(!settings.binaryPath ? { command: definition.installUrl } : {}),
          },
        ],
      };
    }
    const probe = await this.#probe(id, binary, recheck, profileId);
    if (this.#revisions.get(cacheKey) !== revision) return this.status(id, false, profileId);
    // Enabling or rechecking a CLI checks the same protocol used by model
    // discovery. A timeout remains a probe/catalog failure, not incompatibility.
    if (settings.enabled) await this.#loadModels(id, profileId).catch(() => {});
    if (this.#revisions.get(cacheKey) !== revision) return this.status(id, false, profileId);
    return {
      ...base,
      installed: true,
      binaryPath: binary.path,
      binarySource: binary.source,
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
        ...(this.#modelErrors.has(cacheKey)
          ? [this.#modelErrors.get(cacheKey)!.diagnostic]
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
    // Codex shims (.cmd/.ps1) resolve to the packaged native executable; other
    // CLIs still require a direct .exe path.
    const isCodexShim =
      id === "codex-cli" &&
      request.binaryPath &&
      isCodexNpmShim(request.binaryPath);
    if (
      request.binaryPath &&
      /\.(?:cmd|bat|ps1)$/i.test(request.binaryPath) &&
      !isCodexShim
    )
      throw new Error(
        "Choose the program itself (.exe); Windows command scripts cannot be started directly",
      );
    if (request.defaultProfileId !== undefined && (!isAccountRuntimeId(id) || !this.settings.profiles(id).some((profile) => profile.id === request.defaultProfileId)))
      throw new Error("Choose an existing account configuration");
    await this.settings.update(id, {
      ...(request.defaultProfileId !== undefined ? { defaultProfileId: request.defaultProfileId } : {}),
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.permissionMode !== undefined
        ? { permissionMode: request.permissionMode }
        : {}),
      ...(request.binaryPath !== undefined
        ? { binaryPath: request.binaryPath }
        : {}),
    });
    if (request.enabled !== undefined || request.permissionMode !== undefined || request.binaryPath !== undefined) this.#invalidate(id);
    return this.status(id, request.binaryPath !== undefined);
  }

  /** Models of the enabled agents that are installed. One that is slow to answer is left out this time, not waited for. */
  async models(profileIds: AccountProfileIds = {}): Promise<{ models: AgentModel[]; loading: AgentRuntimeId[] }> {
    const loading: AgentRuntimeId[] = [];
    const lists = await Promise.all(
      AGENT_RUNTIME_IDS.map(async (id) => {
        if (!this.settings.get(id).enabled) return [];
        const result = await withinModelsWait(
          this.#loadModels(id, isAccountRuntimeId(id) ? profileIds[id] : undefined).catch(() => [] as AgentModel[]),
        );
        if (result) return result;
        loading.push(id);
        return [];
      }),
    );
    return { models: lists.flat(), loading };
  }

  async model(
    id: AgentRuntimeId,
    modelId: string,
    profileId?: string,
  ): Promise<AgentModel | undefined> {
    if (!this.settings.get(id).enabled) return undefined;
    const models = await this.#loadModels(id, profileId).catch(() => []);
    return models.find((model) => model.id === modelId);
  }

  /**
   * The models an account offers, or undefined when its catalog cannot be read
   * in time (signed out, slow or failing), so callers do not judge a model by it.
   */
  async offeredModels(
    id: AgentRuntimeId,
    profileId?: string,
  ): Promise<AgentModel[] | undefined> {
    if (!this.settings.get(id).enabled) return undefined;
    const models = await withinModelsWait(this.#loadModels(id, profileId).catch(() => undefined));
    return models?.length ? models : undefined;
  }

  /** Starts the CLI's own sign-in. A browser page comes back when the CLI hands one out; otherwise the command to run. */
  async login(id: AgentRuntimeId, profileId?: string): Promise<AgentRuntimeLoginResponse> {
    const definition = AGENT_RUNTIME_DEFINITIONS[id];
    const binary = await resolveBinary(id, this.settings.get(id).binaryPath);
    if (!binary) throw new Error(`${definition.name} is not installed`);
    const loginProfileId = isAccountRuntimeId(id) ? this.#profileId(id, profileId) : undefined;
    const env = await this.#environment(id, binary.path, loginProfileId);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const cacheKey = this.#key(id, loginProfileId);
    await this.#logins.get(cacheKey)?.();
    if (this.#deleting.has(`${id}:${loginProfileId}`)) throw new Error("Account configuration is being deleted");
    const forget = () => {
      if (!this.#deleting.has(`${id}:${loginProfileId}`)) this.#invalidate(id, loginProfileId);
      this.#logins.delete(cacheKey);
    };
    const location = id === "claude-code-cli" ? ["CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR] : id === "codex-cli" ? ["CODEX_HOME", env.CODEX_HOME] : undefined;
    const loginCommand = location?.[1]
      ? process.platform === "win32"
        ? `$env:${location[0]} = '${location[1].replaceAll("'", "''")}'; & '${binary.path.replaceAll("'", "''")}' ${id === "codex-cli" ? "login" : "auth login"}`
        : `${location[0]}='${location[1].replaceAll("'", "'\\''")}' '${binary.path.replaceAll("'", "'\\''")}' ${id === "codex-cli" ? "login" : "auth login"}`
      : definition.loginCommand;
    if (id === "codex-cli") {
      const server = new CodexAppServer(binary.path, this.#root, env, {
        notification: (method) => {
          if (method !== "account/login/completed") return;
          forget();
          void server.stop();
        },
      });
      const stopLogin = () => server.stop();
      this.#logins.set(cacheKey, stopLogin);
      setTimeout(() => {
        if (this.#logins.get(cacheKey) === stopLogin) { forget(); void server.stop(); }
      }, LOGIN_TIMEOUT_MS).unref();
      try {
        await server.initialize();
        const started = await server.request<{ authUrl?: unknown }>(
          "account/login/start",
          { type: "chatgpt" },
        );
        return typeof started.authUrl === "string"
          ? { url: started.authUrl }
          : { command: loginCommand };
      } catch (cause) {
        forget();
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
            if (!found) resolve({ command: loginCommand });
          },
        });
        this.#logins.set(cacheKey, () => child.stop());
        setTimeout(() => {
          if (!found) {
            found = true;
            resolve({ command: loginCommand });
          }
        }, 15_000).unref();
        setTimeout(() => {
          void child.stop();
        }, LOGIN_TIMEOUT_MS).unref();
      });
    }
    return { command: loginCommand };
  }

  async createSession(
    request: NativeSessionRequest,
  ): Promise<NativeCodingSession> {
    request = { ...request, profileId: isAccountRuntimeId(request.runtime) ? this.#profileId(request.runtime, request.profileId) : undefined };
    const settings = this.settings.get(request.runtime);
    const cacheKey = this.#key(request.runtime, request.profileId);
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
    const probe = await this.#probe(request.runtime, binary, false, request.profileId);
    if (probe?.requirementError) throw probe.requirementError;
    // Do not offer a catalog during setup then reject the same CLI only after
    // its first message. This uses the discovery cache and sends no model turn.
    try {
      await this.#loadModels(request.runtime, request.profileId);
    } catch (cause) {
      throw runtimeStartupError(cause);
    }
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
    const env = await this.#environment(request.runtime, binary.path, request.profileId);
    // Codex conversations with the same executable, environment and Skills share one app server.
    const codexServer =
      request.runtime === "codex-cli"
        ? await codexServerIdentity(
            this.#root,
            binary.path,
            env,
            request.skillDirectories,
          )
        : undefined;
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
      instructions: `${request.instructions}\n\n${NATIVE_INSTRUCTIONS}`,
      bridge,
      saveGeneratedImage: request.saveGeneratedImage,
      policy: {
        ...request.policy,
        fullAccess: settings.permissionMode === "full",
        // Claude Code runs every command in its sandbox. Codex asks only for
        // what would leave its sandbox, so its requests are judged strictly.
        sandboxedCommands:
          settings.permissionMode === "standard" &&
          request.runtime === "claude-code-cli" &&
          commandSandbox(request.runtime) === "os",
        readablePaths: [
          stagedSkillsRoot(
            request.runtime,
            codexServer?.directory ?? folder.path,
          ),
        ],
      },
      ...(codexServer ? { codexServer } : {}),
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
      ...(isAccountRuntimeId(request.runtime) ? { profileId: this.#profileId(request.runtime, request.profileId) } : {}),
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
      onLimits: (limits) => this.#recordLimits(cacheKey, limits),
      accountLimits: () => this.#limits.get(cacheKey),
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

  #profileId(runtime: AccountRuntimeId, profileId?: string): string {
    const selected = profileId ?? this.settings.get(runtime).defaultProfileId ?? "system";
    if (this.#deleting.has(`${runtime}:${selected}`)) throw new Error("Account configuration is being deleted");
    if (!this.settings.profiles(runtime).some((profile) => profile.id === selected)) throw new Error("Account configuration not found");
    return selected;
  }

  #key(id: AgentRuntimeId, profileId?: string): string {
    const selected = isAccountRuntimeId(id) ? this.#profileId(id, profileId) : "system";
    return selected === "system" ? id : `${id}:${selected}`;
  }

  /** Read the last quota report without starting a CLI or refreshing authentication. */
  cachedLimits(runtime: AgentRuntimeId, profileId?: string): AgentUsageLimit[] | undefined {
    return this.#limits.get(this.#key(runtime, profileId));
  }

  async accountProfiles(runtime: AccountRuntimeId, recheck = false): Promise<AgentAccountProfileStatus[]> {
    if (recheck) this.#invalidate(runtime);
    return Promise.all(this.settings.profiles(runtime).map(async (profile) => {
      const status = await this.status(runtime, false, profile.id);
      return { ...profile, auth: status.auth, ...(status.limits ? { limits: status.limits } : {}) };
    }));
  }

  async addAccountProfile(runtime: AccountRuntimeId, name: string, configDirectory?: string) {
    if (!name.trim() || name.trim().length > 80) throw new Error("Choose an account configuration name (1–80 characters)");
    let directory = configDirectory ?? path.join(this.#root, "account-profiles", runtime, randomBytes(12).toString("hex"));
    if (!path.isAbsolute(directory)) throw new Error("The configuration directory must be absolute");
    if (configDirectory) {
      const info = await stat(directory).catch(() => undefined);
      if (!info?.isDirectory()) throw new Error("Choose an existing configuration directory");
      directory = await realpath(directory);
      const managedRoot = await realpath(path.join(this.#root, "account-profiles")).catch(() => path.join(this.#root, "account-profiles"));
      if (directory === managedRoot || directory.startsWith(`${managedRoot}${path.sep}`))
        throw new Error("Managed account directories cannot be imported");
      // Naming System default's directory explicitly gives Claude another Keychain entry and global config file.
      const system = runtime === "claude-code-cli"
        ? process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
        : process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      if (directory === await realpath(system).catch(() => path.resolve(system)))
        throw new Error("System default already uses this configuration directory");
    }
    try {
      if (!configDirectory) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // A managed Codex home gets its own file-backed sign-in; do not edit imported configurations.
        if (runtime === "codex-cli") await writeFile(path.join(directory, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
      }
      return await this.settings.addProfile(runtime, name, directory, !configDirectory);
    } catch (cause) {
      if (!configDirectory) await rm(directory, { recursive: true, force: true });
      throw cause;
    }
  }

  async removeAccountProfile(runtime: AccountRuntimeId, profileId: string, releaseSessions: () => Promise<void>): Promise<void> {
    if (profileId === "system") throw new Error("System default cannot be deleted");
    const profile = this.settings.profiles(runtime).find((profile) => profile.id === profileId);
    if (!profile) throw new Error("Account configuration not found");
    const cacheKey = this.#key(runtime, profileId);
    const deletingKey = `${runtime}:${profileId}`;
    const pending = [this.#probing.get(cacheKey), this.#modelLoads.get(cacheKey)];
    const stopLogin = this.#logins.get(cacheKey);
    this.#deleting.add(deletingKey);
    try {
      await releaseSessions();
      await stopLogin?.();
      this.#logins.delete(cacheKey);
      await Promise.allSettled(pending);
      // Invalidate before removing the registry entry; late probes cannot repopulate its cache.
      this.#invalidate(runtime, profileId);
      if (profile.managed) {
        const managedRoot = path.join(this.#root, "account-profiles", runtime);
        if (!profile.configDirectory || path.dirname(profile.configDirectory) !== managedRoot)
          throw new Error("Managed account directory is outside its reserved folder");
        await this.#signOut(runtime, profile.configDirectory);
        await rm(profile.configDirectory, { recursive: true, force: true });
      }
      await this.settings.removeProfile(runtime, profileId);
      this.#limits.delete(cacheKey);
      this.#recordLimitsCache();
    } finally {
      this.#deleting.delete(deletingKey);
    }
  }

  #invalidate(id: AgentRuntimeId, profileId?: string): void {
    const key = (profile: string) => profile === "system" ? id : `${id}:${profile}`;
    const keys = profileId !== undefined ? [key(profileId)]
      : isAccountRuntimeId(id) ? this.settings.profiles(id).map((profile) => key(profile.id)) : [id];
    for (const key of keys) {
      this.#revisions.set(key, (this.#revisions.get(key) ?? 0) + 1);
      this.#probes.delete(key);
      this.#models.delete(key);
      this.#modelErrors.delete(key);
      this.#probing.delete(key);
      this.#modelLoads.delete(key);
    }
  }

  /** The CLI's executable and the environment its commands run in, or undefined when it is not installed. */
  async cli(
    id: AgentRuntimeId,
  ): Promise<{ path: string; env: Record<string, string> } | undefined> {
    const binary = await resolveBinary(id, this.settings.get(id).binaryPath);
    return binary
      ? { path: binary.path, env: await this.#environment(id, binary.path, "system") }
      : undefined;
  }

  async #environment(
    id: AgentRuntimeId,
    binaryPath: string,
    profileId?: string,
  ): Promise<Record<string, string>> {
    const configDirectory = isAccountRuntimeId(id)
      ? this.settings.profiles(id).find((profile) => profile.id === this.#profileId(id, profileId))!.configDirectory
      : undefined;
    return this.#profileEnvironment(id, binaryPath, configDirectory);
  }

  async #profileEnvironment(
    id: AgentRuntimeId,
    binaryPath: string,
    configDirectory?: string,
  ): Promise<Record<string, string>> {
    const env = agentEnvironment(
      id,
      binaryPath,
      {},
      process.env,
      await loginShellPath(),
    );
    if (configDirectory) {
      if (id === "claude-code-cli") {
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        env.CLAUDE_CONFIG_DIR = configDirectory;
      } else if (id === "codex-cli") env.CODEX_HOME = configDirectory;
    }
    return env;
  }

  /**
   * Signs a managed configuration out with its CLI before its directory goes.
   * Claude keeps a macOS sign-in in a Keychain entry keyed to the directory,
   * which removing the directory would leave behind. A missing CLI or a failed
   * sign-out does not keep the directory.
   */
  async #signOut(id: AccountRuntimeId, configDirectory: string): Promise<void> {
    const binary = await resolveBinary(id, this.settings.get(id).binaryPath).catch(() => undefined);
    if (!binary) return;
    const env = await this.#profileEnvironment(id, binary.path, configDirectory);
    await runCli(binary.path, id === "claude-code-cli" ? ["auth", "logout"] : ["logout"], env, this.#root).catch(() => undefined);
  }

  async #probe(
    id: AgentRuntimeId,
    binary: { path: string; signature: string },
    recheck: boolean,
    profileId?: string,
  ): Promise<ProbeCache | undefined> {
    profileId = isAccountRuntimeId(id) ? this.#profileId(id, profileId) : undefined;
    const cacheKey = this.#key(id, profileId);
    const cached = this.#probes.get(cacheKey);
    if (
      !recheck &&
      cached?.signature === binary.signature &&
      Date.now() - cached.checkedAt < STATUS_TTL_MS
    )
      return cached;
    const running = this.#probing.get(cacheKey);
    if (running) return running;
    const revision = this.#revisions.get(cacheKey);
    const work = (async () => {
      const definition = AGENT_RUNTIME_DEFINITIONS[id];
      const env = await this.#environment(id, binary.path, profileId);
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
      let requirementError: Error | undefined;
      try {
        checkRuntimeVersionRequirement(
          id,
          version,
          this.settings.get(id).permissionMode,
        );
      } catch (cause) {
        requirementError =
          cause instanceof Error ? cause : new Error(String(cause));
        diagnostics.push({
          code:
            cause instanceof AgentRuntimeCompatibilityError
              ? "runtime-incompatible"
              : "probe-failed",
          message: requirementError.message,
          ...(cause instanceof AgentRuntimeCompatibilityError &&
          cause.capability
            ? { capability: cause.capability }
            : {}),
        });
      }
      if (!version && !diagnostics.some((item) => item.code === "probe-failed"))
        diagnostics.push({
          code: "probe-failed",
          message: `${definition.name} did not return a readable version`,
        });
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
        ...(requirementError ? { requirementError } : {}),
      };
      if (this.#revisions.get(cacheKey) === revision) this.#probes.set(cacheKey, result);
      return result;
    })().finally(() => {
      if (this.#probing.get(cacheKey) === work) this.#probing.delete(cacheKey);
    });
    this.#probing.set(cacheKey, work);
    return work;
  }

  #loadModels(id: AgentRuntimeId, profileId?: string): Promise<AgentModel[]> {
    profileId = isAccountRuntimeId(id) ? this.#profileId(id, profileId) : undefined;
    const cacheKey = this.#key(id, profileId);
    const running = this.#modelLoads.get(cacheKey);
    if (running) return running;
    const revision = this.#revisions.get(cacheKey);
    const work = (async () => {
      const settings = this.settings.get(id);
      const binary = await resolveBinary(id, settings.binaryPath);
      if (!binary) return [];
      const cached = this.#models.get(cacheKey);
      if (
        cached?.signature === binary.signature &&
        Date.now() - cached.at < MODELS_TTL_MS
      )
        return cached.models;
      const probe = await this.#probe(id, binary, false, profileId);
      if (probe?.requirementError) throw probe.requirementError;
      const failed = this.#modelErrors.get(cacheKey);
      if (
        failed?.signature === binary.signature &&
        failed.cause &&
        Date.now() - failed.at < STATUS_TTL_MS
      )
        throw failed.cause;
      const env = await this.#environment(id, binary.path, profileId);
      await mkdir(path.join(this.#root, "probes"), {
        recursive: true,
        mode: 0o700,
      });
      const folder = await privateFolder(path.join(this.#root, "probes"), id);
      try {
        const { models, account, limits } = await probeModels(
          binary.path,
          id,
          env,
          folder.path,
        );
        if (this.#revisions.get(cacheKey) !== revision) return [];
        this.#models.set(cacheKey, {
          signature: binary.signature,
          models,
          at: Date.now(),
        });
        this.#modelErrors.delete(cacheKey);
        if (!models.length)
          this.#modelErrors.set(cacheKey, {
            signature: binary.signature,
            at: Date.now(),
            diagnostic: {
              code: "models-unavailable",
              message: `${AGENT_RUNTIME_DEFINITIONS[id].name} returned an empty model catalog. Check sign-in and CLI protocol support.`,
            },
          });
        if (limits) this.#recordLimits(cacheKey, limits);
        const probe = this.#probes.get(cacheKey);
        if (account && probe && !probe.auth.account)
          probe.auth = { ...probe.auth, account };
        return models;
      } catch (cause) {
        if (this.#revisions.get(cacheKey) === revision)
          this.#modelErrors.set(cacheKey, {
            signature: binary.signature,
            at: Date.now(),
            cause: cause instanceof Error ? cause : new Error(String(cause)),
            diagnostic: {
              code:
                cause instanceof AgentRuntimeCompatibilityError
                  ? "runtime-incompatible"
                  : "models-unavailable",
              message: cause instanceof Error ? cause.message : String(cause),
              ...(cause instanceof AgentRuntimeCompatibilityError &&
              cause.capability
                ? { capability: cause.capability }
                : {}),
            },
          });
        throw cause;
      } finally {
        await folder.remove();
      }
    })().finally(() => {
      if (this.#modelLoads.get(cacheKey) === work) this.#modelLoads.delete(cacheKey);
    });
    this.#modelLoads.set(cacheKey, work);
    return work;
  }
}

function isUsageLimit(value: unknown): value is AgentUsageLimit {
  const limit = value as AgentUsageLimit | null;
  return (
    !!limit &&
    typeof limit.id === "string" &&
    typeof limit.usedPercent === "number" &&
    (limit.windowMinutes === undefined ||
      typeof limit.windowMinutes === "number") &&
    (limit.resetsAt === undefined || typeof limit.resetsAt === "number")
  );
}
