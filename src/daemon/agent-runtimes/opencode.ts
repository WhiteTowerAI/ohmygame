import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import type {
  NativeDriver,
  NativeToolResult,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
} from "./native-session.js";
import { AgentProcess, processFailure } from "./process.js";
import { BRIDGE_SERVER_NAME, ToolBridge } from "./tool-bridge.js";
import {
  decideApproval,
  number,
  piToolCall,
  PLANNING_DENIAL,
  record,
  textResult,
  type DriverContext,
} from "./driver-context.js";
import { stageSkills, stagedSkillsRoot } from "./skills.js";
import { canonicalPath, judgeApproval, planningPolicy } from "./policy.js";
import { NativeSessionExpiredError } from "./native-session.js";
import {
  AgentRuntimeCompatibilityError,
  cliProbeError,
  runtimeStartupError,
  checkRuntimeVersionRequirement,
} from "./compatibility.js";

const START_TIMEOUT_MS = 30_000;
const CALLBACK_PERMISSIONS = [{ action: "*", resource: "*", effect: "ask" }];
const SESSION_PREFIX = "opencode-v2:";
const PERMISSION_DENIAL =
  "OhMyGame denied this request. Do not retry it through another tool or command. Explain the denial and continue only with permitted work.";

interface OpenCodeServer {
  process: AgentProcess;
  url: string;
  auth: string;
  events: AbortController;
}

interface OpenCodeTurn {
  sink: NativeTurnSink;
  signal: AbortSignal;
  resolve: (outcome: NativeTurnOutcome) => void;
  /** Parts already reported, by part id. */
  parts: Map<
    string,
    { length: number; done: boolean }
  >;
  tools: Set<string>;
  error?: string;
  manualCompaction?: boolean;
  readOnly?: boolean;
}

/**
 * OpenCode through `opencode serve`, one server per conversation on a
 * loopback port with a password of its own. Messages go to the session's
 * prompt endpoint, everything that happens comes back on its event stream,
 * and permission requests are answered on the server. OhMyGame's tools are
 * a remote MCP server on the daemon whose token only works while a turn of
 * this conversation runs.
 */
export class OpenCodeDriver implements NativeDriver {
  /** Probe the same server used by real turns, without a session or inference. */
  static async discover(
    context: Pick<
      DriverContext,
      "binaryPath" | "env" | "privateDirectory"
    >,
  ): Promise<unknown> {
    const driver = new OpenCodeDriver({
      ...context,
      workspacePath: context.privateDirectory,
      policy: { workspacePath: context.privateDirectory, neverTouch: [] },
      bridge: new ToolBridge([]),
      instructions: "",
      model: "",
      skillDirectories: [],
    });
    try {
      await driver.#start();
      return await driver.#api("GET", "/model");
    } catch (cause) {
      if (cause instanceof AgentRuntimeCompatibilityError) throw cause;
      throw cliProbeError(
        "OpenCode",
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      await driver.dispose();
    }
  }

  #disposed = false;
  #server?: OpenCodeServer;
  #launching?: AgentProcess;
  #starting?: Promise<OpenCodeServer>;
  #sessionId?: string;
  #projectId?: string;
  #legacyResume = false;
  #turn?: OpenCodeTurn;
  #bridge?: { url: string; token: string; revoke: () => void };
  #toolInputs = new Map<
    string,
    { name: string; input: Record<string, unknown> }
  >();
  /** What bridged OhMyGame tools returned, by tool and arguments: OpenCode's record of the call has only MCP's text. */
  #bridged = new Map<
    string,
    Array<{ result: NativeToolResult; isError: boolean }>
  >();

  constructor(private readonly context: DriverContext) {
    this.#legacyResume = Boolean(
      context.resume && !context.resume.startsWith(SESSION_PREFIX),
    );
    this.#sessionId = context.resume?.startsWith(SESSION_PREFIX)
      ? context.resume.slice(SESSION_PREFIX.length)
      : undefined;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    if (signal.aborted) return { status: "aborted" };
    let sessionId: string;
    try {
      await this.#start();
      if (signal.aborted) return { status: "aborted" };
      sessionId = await this.#session(sink);
      if (signal.aborted) return { status: "aborted" };
    } catch (cause) {
      if (signal.aborted) return { status: "aborted" };
      if (cause instanceof NativeSessionExpiredError) throw cause;
      return {
        status: "failed",
        error: runtimeStartupError(cause).message,
      };
    }
    this.#toolInputs.clear();
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: OpenCodeTurn = {
        sink,
        signal,
        resolve,
        parts: new Map(),
        tools: new Set(),
        readOnly: input.readOnly,
      };
      this.#turn = turn;
      this.#connectBridge(turn)
        .then(() => this.#prompt(sessionId, input, signal))
        .catch((cause) => {
          if (this.#turn !== turn) return;
          this.#turn = undefined;
          this.#bridge?.revoke();
          resolve(
            signal.aborted
              ? { status: "aborted" }
              : {
                  status: "failed",
                  error: cause instanceof Error ? cause.message : String(cause),
                },
          );
        });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.#sessionId || !this.#server) return;
    await this.#api("POST", `/session/${this.#sessionId}/interrupt`).catch(
      () => {},
    );
  }

  async compact(sink: NativeTurnSink, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await this.#start();
    if (signal.aborted) return;
    const sessionId = await this.#session(sink);
    if (signal.aborted) return;
    sink.compaction("start");
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      const turn: OpenCodeTurn = {
        sink,
        signal,
        resolve,
        parts: new Map(),
        tools: new Set(),
        manualCompaction: true,
      };
      this.#turn = turn;
      this.#api("POST", `/session/${sessionId}/compact`, {}).catch((cause) => {
        if (this.#turn !== turn) return;
        this.#turn = undefined;
        resolve({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
    sink.compaction(
      "end",
      outcome.status === "failed" ? { error: outcome.error } : {},
    );
    if (outcome.status === "failed") throw new Error(outcome.error);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const turn = this.#turn;
    this.#turn = undefined;
    this.#bridge?.revoke();
    this.#bridge = undefined;
    this.#server?.events.abort();
    await (this.#server?.process ?? this.#launching)?.stop();
    turn?.resolve({ status: "aborted" });
    this.#server = undefined;
  }

  /** Whether a turn of this conversation is running, which is when its tool token works. */
  get active(): boolean {
    return Boolean(this.#turn);
  }

  async #prompt(
    sessionId: string,
    input: NativeTurnInput,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.#checkSavedPermissions();
    signal.throwIfAborted();
    const [providerID, id] = splitModel(this.context.model);
    await this.#api("POST", `/session/${sessionId}/model`, {
      model: {
        providerID,
        id,
        ...(this.context.reasoningLevel
          ? { variant: this.context.reasoningLevel }
          : {}),
      },
    });
    signal.throwIfAborted();
    await this.#api("POST", `/session/${sessionId}/agent`, {
      agent: input.readOnly ? "plan" : "build",
    });
    signal.throwIfAborted();
    await this.#api("POST", `/session/${sessionId}/prompt`, {
      text: input.text,
      files: input.images.map((image, index) => ({
        name: `image-${index + 1}`,
        uri: `data:${image.mimeType};base64,${image.data}`,
      })),
    });
  }

  async #session(sink: NativeTurnSink): Promise<string> {
    if (this.#legacyResume)
      throw new NativeSessionExpiredError(
        "OpenCode v1 context must be rebuilt for v2",
      );
    if (this.#sessionId) {
      try {
        await this.#api("GET", `/session/${this.#sessionId}`);
      } catch (cause) {
        if (cause instanceof OpenCodeHttpError && cause.status === 404)
          throw new NativeSessionExpiredError(cause.message);
        throw cause;
      }
    } else {
      const created = record(
        await this.#api("POST", "/session", {
          title: "OhMyGame",
          location: { directory: this.context.workspacePath },
          permissions: CALLBACK_PERMISSIONS,
        }),
      );
      if (typeof created?.id !== "string")
        throw new Error("OpenCode did not start a session");
      this.#sessionId = created.id;
    }
    // Reapply and verify on resume too; never inherit a previous native permission grant.
    await this.#api("PATCH", `/session/${this.#sessionId}`, {
      permissions: CALLBACK_PERMISSIONS,
    });
    const info = record(await this.#api("GET", `/session/${this.#sessionId}`));
    const directory = record(info?.location)?.directory;
    if (
      typeof directory !== "string" ||
      canonicalPath(directory) !== canonicalPath(this.context.workspacePath)
    )
      throw new NativeSessionExpiredError(
        "OpenCode session no longer belongs to this workspace",
      );
    if (!hasCallbackPermissions(info?.permissions))
      throw new AgentRuntimeCompatibilityError(
        "OpenCode did not enable OhMyGame's permission callbacks for this session.",
        "session.permissions=ask",
      );
    sink.nativeSession(SESSION_PREFIX + this.#sessionId);
    return this.#sessionId;
  }

  async #checkSavedPermissions(): Promise<void> {
    const result = await this.#api(
      "GET",
      "/permission/saved",
      undefined,
      false,
      { projectID: this.#projectId! },
    );
    if (!Array.isArray(result))
      throw new Error("OpenCode did not report its saved permissions");
    if (result.length)
      throw new AgentRuntimeCompatibilityError(
        "OpenCode has saved permissions for this project that can bypass OhMyGame's approvals. Remove those grants in OpenCode and check again. OhMyGame does not delete your CLI permissions.",
        "no saved OpenCode permissions for this project",
      );
  }

  async #start(): Promise<OpenCodeServer> {
    if (this.#disposed) throw new Error("The agent session was closed");
    if (this.#server?.process.running) return this.#server;
    return (this.#starting ??= (async () => {
      try {
        const password = randomBytes(24).toString("base64url");
        const env = {
          ...this.context.env,
          ...(await this.#environment()),
          OPENCODE_SERVER_PASSWORD: password,
        };
        if (this.#disposed) throw new Error("The agent session was closed");
        let listening: (url: string) => void = () => {};
        const url = new Promise<string>((resolve) => {
          listening = resolve;
        });
        const child = new AgentProcess({
          binaryPath: this.context.binaryPath,
          args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
          cwd: this.context.workspacePath,
          env,
          processDirectory: this.context.processDirectory,
          onLine: (line) => {
            try {
              const info = JSON.parse(line) as { url?: unknown };
              if (
                typeof info.url === "string" &&
                /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url)
              )
                listening(info.url);
            } catch {
              /* Logs are not server announcements. */
            }
          },
          onExit: (code, signal, stderr) =>
            this.#exited(
              child,
              processFailure("OpenCode", code, signal, stderr),
            ),
        });
        this.#launching = child;
        let startTimer: ReturnType<typeof setTimeout> | undefined;
        const address = await Promise.race([
          url,
          child.exited().then(() => undefined),
          new Promise<undefined>(
            (resolve) =>
              (startTimer = setTimeout(
                () => resolve(undefined),
                START_TIMEOUT_MS,
              )),
          ),
        ]);
        clearTimeout(startTimer);
        if (!address) {
          await child.stop();
          throw new Error(
            processFailure(
              "OpenCode",
              child.child.exitCode,
              child.child.signalCode,
              child.stderr || "did not start its server",
            ),
          );
        }
        if (this.#disposed) {
          await child.stop();
          throw new Error("The agent session was closed");
        }
        const events = new AbortController();
        const server = {
          process: child,
          url: address,
          auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          events,
        };
        this.#server = server;
        let connected!: () => void;
        let failed!: (cause: unknown) => void;
        const ready = new Promise<void>((resolve, reject) => {
          connected = resolve;
          failed = reject;
        });
        const connectTimer = setTimeout(
          () =>
            events.abort(new Error("OpenCode event stream did not connect")),
          START_TIMEOUT_MS,
        );
        void this.#listen(server, connected, failed);
        try {
          await ready;
        } finally {
          clearTimeout(connectTimer);
        }
        if (this.#disposed) throw new Error("The agent session was closed");
        const info = record(await this.#api("GET", "/info", undefined, false));
        checkRuntimeVersionRequirement(
          "opencode-cli",
          typeof info?.version === "string" ? info.version : undefined,
          "standard",
        );
        const location = record(await this.#api("GET", "/location"));
        if (
          typeof location?.directory !== "string" ||
          !path.isAbsolute(location.directory) ||
          typeof record(location.project)?.id !== "string"
        )
          throw new AgentRuntimeCompatibilityError(
            "OpenCode did not report its location and project identity.",
            "location.directory / project.id",
          );
        this.#projectId = String(record(location.project)!.id);
        await this.#checkSavedPermissions();
        // V2 can return the built-in catalog before configuration transforms finish.
        // Do not send a prompt until every agent has the callback policy applied.
        const deadline = Date.now() + 5_000;
        for (;;) {
          const agents = await this.#api("GET", "/agent");
          if (
            Array.isArray(agents) &&
            ["build", "plan"].every((id) =>
              agents.some((a) => record(a)?.id === id),
            ) &&
            agents.every((agent) =>
              hasCallbackPermissions(record(agent)?.permissions),
            )
          )
            break;
          if (Date.now() >= deadline)
            throw new AgentRuntimeCompatibilityError(
              "OpenCode did not enable OhMyGame's permission callbacks for its agents. Check its configuration and plugins, then check again.",
              "build/plan permissions=ask",
            );
          await delay(50, undefined, { signal: events.signal });
        }
        return server;
      } catch (cause) {
        const server = this.#server;
        this.#server = undefined;
        server?.events.abort();
        await (server?.process ?? this.#launching)?.stop();
        throw cause;
      } finally {
        this.#launching = undefined;
        this.#starting = undefined;
      }
    })());
  }

  /** V2 uses the person's CLI configuration, with app instructions and callback rules added. */
  async #environment(): Promise<Record<string, string>> {
    const { context } = this;
    const skills = stagedSkillsRoot("opencode-cli", context.privateDirectory);
    const staged = context.skillDirectories.length
      ? await stageSkills(context.skillDirectories, skills)
      : [];
    const instructions = path.join(context.privateDirectory, "instructions.md");
    await writeFile(instructions, context.instructions, { mode: 0o600 });
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        share: "disabled",
        snapshots: false,
        permissions: CALLBACK_PERMISSIONS,
        agents: {
          build: { permissions: CALLBACK_PERMISSIONS },
          plan: { permissions: CALLBACK_PERMISSIONS },
        },
        instructions: [instructions],
        ...(staged.length ? { skills: [skills] } : {}),
      }),
    };
  }

  async #api(
    method: string,
    route: string,
    body?: unknown,
    location = true,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    const server = this.#server;
    if (!server) throw new Error("OpenCode is not running");
    const url = new URL(`/api${route}`, server.url);
    if (location)
      url.searchParams.set("location[directory]", this.context.workspacePath);
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    const response = await fetch(url, {
      method,
      headers: {
        authorization: server.auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        server.events.signal,
      ]),
    });
    const text = await response.text();
    if (!response.ok)
      throw new OpenCodeHttpError(
        response.status,
        `OpenCode refused ${route}: ${text.slice(0, 500) || response.status}`,
      );
    if (!text) return undefined;
    const value: unknown = JSON.parse(text);
    const envelope = record(value);
    return envelope && Object.hasOwn(envelope, "data") ? envelope.data : value;
  }

  async #connectBridge(turn: OpenCodeTurn): Promise<void> {
    this.#bridge?.revoke();
    this.#bridged.clear();
    if (!this.context.httpBridge) return;
    turn.signal.throwIfAborted();
    const bridge = await this.context.httpBridge({
      signal: turn.signal,
      active: () => this.#turn === turn && !turn.signal.aborted,
      observe: (call, outcome) => {
        if (this.#turn !== turn || turn.signal.aborted) return;
        const key = bridgedKey(call.name, call.args);
        this.#bridged.set(key, [...(this.#bridged.get(key) ?? []), outcome]);
      },
    });
    this.#bridge = bridge;
    try {
      await this.#api("PUT", `/experimental/mcp/${BRIDGE_SERVER_NAME}`, {
        config: {
          type: "remote",
          url: bridge.url,
          disabled: false,
          oauth: false,
          codemode: false,
          headers: { Authorization: `Bearer ${bridge.token}` },
        },
      });
      // Registration starts an asynchronous connection in v2. Wait for its
      // catalog before the first prompt, or the model can miss all app tools.
      turn.signal.throwIfAborted();
      await this.#api(
        "POST",
        `/experimental/mcp/${BRIDGE_SERVER_NAME}/connect`,
      );
      const servers = await this.#api("GET", "/mcp");
      if (
        !Array.isArray(servers) ||
        !servers.some(
          (entry) =>
            record(entry)?.name === BRIDGE_SERVER_NAME &&
            record(record(entry)?.status)?.status === "connected",
        )
      )
        throw new Error("OpenCode could not connect OhMyGame's tool bridge");
      turn.signal.throwIfAborted();
    } catch (cause) {
      bridge.revoke();
      throw cause;
    }
  }

  async #listen(
    server: OpenCodeServer,
    connected: () => void,
    failed: (cause: unknown) => void,
  ): Promise<void> {
    try {
      const response = await fetch(`${server.url}/api/event`, {
        headers: {
          authorization: server.auth,
        },
        signal: server.events.signal,
      });
      if (!response.ok || !response.body)
        throw new Error(`OpenCode event stream failed (${response.status})`);
      connected();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            this.#event(
              JSON.parse(data) as {
                type?: string;
                data?: Record<string, unknown>;
              },
            );
          } catch {
            /* An event that cannot be read is skipped. */
          }
        }
      }
      if (!server.events.signal.aborted)
        throw new Error("OpenCode event stream disconnected");
    } catch (cause) {
      failed(cause);
      if (!server.events.signal.aborted) {
        const turn = this.#turn;
        this.#turn = undefined;
        await server.process.stop();
        turn?.resolve({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  #event(event: { type?: string; data?: Record<string, unknown> }): void {
    const turn = this.#turn;
    const data = event.data ?? {};
    if (event.type === "permission.asked") {
      if (turn) void this.#permission(turn, data);
      else void this.#reply(data, "reject");
      return;
    }
    if (!turn || data.sessionID !== this.#sessionId) return;
    const sink = turn.sink;
    const type = event.type ?? "";
    if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(type)) {
      const kind = type.includes(".reasoning.") ? "reasoning" : "text";
      const id = `${String(data.assistantMessageID)}:${kind}:${String(data.ordinal)}`;
      let part = turn.parts.get(id);
      if (!part) {
        part = { length: 0, done: false };
        turn.parts.set(id, part);
      }
      if (part.done) return;
      const text = typeof data.text === "string" ? data.text : undefined;
      const delta =
        type.endsWith(".delta") && typeof data.delta === "string"
          ? data.delta
          : (text?.slice(part.length) ?? "");
      if (delta) {
        part.length += delta.length;
        if (kind === "text") sink.text(id, delta);
        else sink.thinking(id, delta);
      }
      if (type.endsWith(".ended")) {
        part.done = true;
        if (kind === "text") sink.textDone(id, text);
        else sink.thinkingDone(id, text);
      }
      return;
    }
    switch (type) {
      case "session.tool.input.started":
        this.#toolInputs.set(String(data.id), {
          name: String(data.name),
          input: {},
        });
        return;
      case "session.tool.called": {
        const id = String(data.id);
        const tool = this.#toolInputs.get(id);
        if (!tool || turn.tools.has(id)) return;
        tool.input = record(data.input) ?? {};
        turn.tools.add(id);
        const call = openCodeToolCall(tool.name, tool.input);
        sink.toolCall(id, call.name, call.args);
        sink.toolStarted(id);
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const id = String(data.id);
        const tool = this.#toolInputs.get(id);
        if (!tool || !turn.tools.has(id)) return;
        const bridged = tool.name.startsWith(`${BRIDGE_SERVER_NAME}_`)
          ? this.#takeBridged(
              tool.name.slice(BRIDGE_SERVER_NAME.length + 1),
              tool.input,
            )
          : undefined;
        sink.toolResult(
          id,
          bridged?.result ??
            textResult(
              type.endsWith(".failed")
                ? openCodeError(data.error)
                : data.content,
            ),
          bridged?.isError ?? type.endsWith(".failed"),
        );
        this.#toolInputs.delete(id);
        return;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const tokens = record(data.tokens);
        if (tokens) {
          const cache = record(tokens.cache);
          sink.usage(
            {
              input: number(tokens.input),
              output: number(tokens.output),
              cacheRead: number(cache?.read),
              cacheWrite: number(cache?.write),
            },
            this.context.contextWindow,
            number(tokens.input) + number(cache?.read) + number(cache?.write) ||
              undefined,
          );
        }
        return;
      }
      case "session.compaction.started":
        if (!turn.manualCompaction) sink.compaction("start");
        return;
      case "session.compaction.ended":
        if (!turn.manualCompaction) sink.compaction("end", {});
        return;
      case "session.compaction.failed":
        turn.error = openCodeError(data.error);
        if (!turn.manualCompaction)
          sink.compaction("end", { error: turn.error });
        return;
      case "session.execution.failed":
        turn.error = openCodeError(data.error);
        break;
      case "session.execution.interrupted":
        break;
      case "session.execution.succeeded":
        break;
      default:
        return;
    }
    this.#turn = undefined;
    this.#toolInputs.clear();
    this.#bridge?.revoke();
    if (turn.signal.aborted || type === "session.execution.interrupted")
      turn.resolve({ status: "aborted" });
    else if (turn.error) turn.resolve({ status: "failed", error: turn.error });
    else turn.resolve({ status: "completed" });
  }

  async #reply(
    request: Record<string, unknown>,
    decision: "once" | "reject",
    message?: string,
  ): Promise<void> {
    if (typeof request.sessionID !== "string" || typeof request.id !== "string")
      return;
    await this.#api(
      "POST",
      `/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(request.id)}/reply`,
      {
        decision,
        ...(message ? { message } : {}),
      },
    ).catch(() => {});
  }

  #takeBridged(
    name: string,
    args: unknown,
  ): { result: NativeToolResult; isError: boolean } | undefined {
    const key = bridgedKey(name, args);
    const queue = this.#bridged.get(key);
    const outcome = queue?.shift();
    if (queue && !queue.length) this.#bridged.delete(key);
    return outcome;
  }

  async #permission(
    turn: OpenCodeTurn,
    request: Record<string, unknown>,
  ): Promise<void> {
    if (
      typeof request.sessionID !== "string" ||
      !(await this.#belongsToSession(request.sessionID)) ||
      turn.signal.aborted ||
      this.#turn !== turn
    ) {
      await this.#reply(request, "reject");
      return;
    }
    const permission = String(request.action ?? "");
    const patterns = Array.isArray(request.resources)
      ? request.resources.map(String)
      : [];
    const metadata = record(request.metadata) ?? {};
    // V2 file resources are relative to the session location, even inside a Git worktree.
    // Search patterns are not file paths.
    const filePermission = [
      "external_directory",
      "edit",
      "read",
      "list",
    ].includes(permission);
    const resolvePattern = (value: string) =>
      path.resolve(this.context.workspacePath, value);
    const command =
      typeof metadata.command === "string"
        ? metadata.command
        : permission === "shell"
          ? patterns.join(" ")
          : undefined;
    const file =
      typeof metadata.filepath === "string"
        ? metadata.filepath
        : typeof metadata.filePath === "string"
          ? metadata.filePath
          : ["glob", "grep"].includes(permission)
            ? typeof metadata.path === "string"
              ? path.resolve(this.context.workspacePath, metadata.path)
              : this.context.workspacePath
            : filePermission && patterns[0]
              ? resolvePattern(patterns[0])
              : undefined;
    const details: ApprovalRequestDetails = {
      kind: command !== undefined ? "command" : file ? "file" : "other",
      tool: permission || "tool",
      ...(command !== undefined ? { command } : {}),
      ...(file ? { path: file } : {}),
      ...(!file && command === undefined && patterns.length
        ? { reason: `Native ${permission} request: ${patterns.join(", ")}` }
        : {}),
      ...(filePermission && patterns.length > 1
        ? {
            paths: patterns.map((value) => ({
              path: resolvePattern(value),
              access:
                permission === "edit" ? ("write" as const) : ("read" as const),
            })),
          }
        : {}),
      canAllowSession:
        Array.isArray(request.save) &&
        request.save.length > 0 &&
        (file !== undefined || command !== undefined),
    };
    const callId =
      typeof record(request.source)?.id === "string"
        ? String(record(request.source)!.id)
        : undefined;
    let decision: ApprovalDecision;
    // A rejection with feedback lets OpenCode adjust and continue; a bare one stops its loop.
    let feedback: string | undefined;
    try {
      if (
        OPENCODE_OWN_PERMISSIONS.has(permission) ||
        this.context.bridge
          .list()
          .some((tool) => `${BRIDGE_SERVER_NAME}_${tool.name}` === permission)
      )
        decision = "allow";
      else if (turn.readOnly && !OPENCODE_READ_PERMISSIONS.has(permission)) {
        decision =
          permission === "shell" &&
          judgeApproval(details, planningPolicy(this.context.policy)) ===
            "allow"
            ? "allow"
            : "deny";
        if (decision === "deny") feedback = PLANNING_DENIAL;
      } else
        decision = await decideApproval(details, this.context, turn.sink, {
          ...(callId ? { callId } : {}),
          signal: turn.signal,
        });
    } catch {
      decision = "deny";
    }
    if (turn.signal.aborted || this.#turn !== turn) {
      decision = "deny";
      feedback = undefined;
    }
    // Conversation grants stay in OhMyGame, never in OpenCode's persisted patterns.
    await this.#reply(
      request,
      decision === "deny" ? "reject" : "once",
      decision === "deny" && !turn.signal.aborted && this.#turn === turn
        ? (feedback ?? PERMISSION_DENIAL)
        : undefined,
    );
  }

  async #belongsToSession(id: string): Promise<boolean> {
    const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth++) {
      if (id === this.#sessionId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      const info = record(
        await this.#api("GET", `/session/${encodeURIComponent(id)}`).catch(
          () => undefined,
        ),
      );
      const directory = record(info?.location)?.directory;
      if (
        typeof directory !== "string" ||
        canonicalPath(directory) !== canonicalPath(this.context.workspacePath)
      )
        return false;
      if (typeof info?.parentID !== "string") return false;
      id = info.parentID;
    }
    return false;
  }

  #exited(child: AgentProcess, failure: string): void {
    if (this.#server?.process !== child) return;
    this.#server.events.abort();
    this.#server = undefined;
    this.#bridge?.revoke();
    const turn = this.#turn;
    this.#turn = undefined;
    turn?.resolve(
      turn.signal.aborted
        ? { status: "aborted" }
        : { status: "failed", error: failure },
    );
  }
}

/**
 * OpenCode requests that touch no file and run no command: subagents (whose
 * own requests arrive here with their session's ancestry checked), its todo
 * list, Skill loading and web research. Asking would interrupt the person for
 * the agent's bookkeeping, and planning may use them too.
 */
const OPENCODE_OWN_PERMISSIONS = new Set([
  "subagent",
  "todowrite",
  "todoread",
  "skill",
  "webfetch",
  "websearch",
]);

/** What a planning turn may request; bash only for the read commands the policy allows. */
const OPENCODE_READ_PERMISSIONS = new Set([
  "read",
  "glob",
  "grep",
  "list",
  "external_directory",
]);

class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** OpenCode names models `provider/model`; the provider comes first, the rest is the model. */
export function splitModel(model: string): [string, string] {
  const index = model.indexOf("/");
  return index < 0
    ? ["opencode", model]
    : [model.slice(0, index), model.slice(index + 1)];
}

/** OhMyGame's tools by their own names; OpenCode's file and shell tools by Pi's. */
export function openCodeToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  const prefix = `${BRIDGE_SERVER_NAME}_`;
  if (name.startsWith(prefix))
    return { name: name.slice(prefix.length), args: input };
  return piToolCall(name, input);
}

function bridgedKey(name: string, args: unknown): string {
  return `${name}\n${stableJson(args ?? {})}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Later deny/ask exceptions are safe; a later allow could bypass callbacks. */
function hasCallbackPermissions(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const index = value.findLastIndex(
    (v) =>
      record(v)?.action === "*" &&
      record(v)?.resource === "*" &&
      record(v)?.effect === "ask",
  );
  return (
    index >= 0 &&
    value
      .slice(index + 1)
      .every((v) => ["ask", "deny"].includes(String(record(v)?.effect)))
  );
}

function openCodeError(value: unknown): string {
  const error = record(value);
  return typeof error?.message === "string"
    ? error.message
    : typeof record(error?.data)?.message === "string"
      ? String(record(error?.data)!.message)
      : typeof value === "string"
        ? value
        : "OpenCode reported an error";
}
