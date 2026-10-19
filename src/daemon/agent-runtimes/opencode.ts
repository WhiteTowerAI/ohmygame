import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";
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
import { judgeApproval, planningPolicy } from "./policy.js";
import { NativeSessionExpiredError } from "./native-session.js";

const START_TIMEOUT_MS = 30_000;

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
    { kind: "text" | "reasoning"; length: number; done: boolean }
  >;
  tools: Set<string>;
  busy: boolean;
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
  #disposed = false;
  #server?: OpenCodeServer;
  #launching?: AgentProcess;
  #starting?: Promise<OpenCodeServer>;
  #sessionId?: string;
  #worktree?: string;
  #turn?: OpenCodeTurn;
  #bridge?: { url: string; token: string; revoke: () => void };
  #userMessages = new Set<string>();
  /** What bridged OhMyGame tools returned, by tool and arguments: OpenCode's record of the call has only MCP's text. */
  #bridged = new Map<
    string,
    Array<{ result: NativeToolResult; isError: boolean }>
  >();

  constructor(private readonly context: DriverContext) {
    this.#sessionId = context.resume;
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
      if (cause instanceof NativeSessionExpiredError) throw cause;
      return {
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: OpenCodeTurn = {
        sink,
        signal,
        resolve,
        parts: new Map(),
        tools: new Set(),
        busy: false,
        readOnly: input.readOnly,
      };
      this.#turn = turn;
      this.#connectBridge(turn)
        .then(() => this.#prompt(sessionId, input))
        .catch((cause) => {
          if (this.#turn !== turn) return;
          this.#turn = undefined;
          this.#bridge?.revoke();
          resolve({
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.#sessionId || !this.#server) return;
    await this.#api("POST", `/session/${this.#sessionId}/abort`).catch(
      () => {},
    );
  }

  async compact(sink: NativeTurnSink, signal: AbortSignal): Promise<void> {
    await this.#start();
    const sessionId = await this.#session(sink);
    sink.compaction("start");
    const [providerID, modelID] = splitModel(this.context.model);
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      const turn: OpenCodeTurn = {
        sink,
        signal,
        resolve,
        parts: new Map(),
        tools: new Set(),
        busy: true,
        manualCompaction: true,
      };
      this.#turn = turn;
      this.#api("POST", `/session/${sessionId}/summarize`, {
        providerID,
        modelID,
      }).catch((cause) => {
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

  async #prompt(sessionId: string, input: NativeTurnInput): Promise<void> {
    const [providerID, modelID] = splitModel(this.context.model);
    await this.#api("POST", `/session/${sessionId}/prompt_async`, {
      model: { providerID, modelID },
      ...(this.context.reasoningLevel
        ? { variant: this.context.reasoningLevel }
        : {}),
      agent: input.readOnly ? "plan" : "build",
      system: this.context.instructions,
      parts: [
        { type: "text", text: input.text },
        ...input.images.map((image, index) => ({
          type: "file",
          mime: image.mimeType,
          filename: `image-${index + 1}`,
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
    });
  }

  async #session(sink: NativeTurnSink): Promise<string> {
    if (this.#sessionId) {
      try {
        await this.#api("GET", `/session/${this.#sessionId}`);
        sink.nativeSession(this.#sessionId);
        return this.#sessionId;
      } catch (cause) {
        if (cause instanceof OpenCodeHttpError && cause.status === 404)
          throw new NativeSessionExpiredError(cause.message);
        throw cause;
      }
    }
    const created = (await this.#api("POST", "/session", {
      title: "OhMyGame",
    })) as { id?: unknown };
    if (typeof created.id !== "string")
      throw new Error("OpenCode did not start a session");
    this.#sessionId = created.id;
    sink.nativeSession(created.id);
    return created.id;
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
          args: [
            "serve",
            ...(this.context.isolateUserConfig ? ["--pure"] : []),
            "--hostname",
            "127.0.0.1",
            "--port",
            "0",
          ],
          cwd: this.context.workspacePath,
          env,
          processDirectory: this.context.processDirectory,
          onLine: (line) => {
            const match = line.match(
              /listening on (http:\/\/127\.0\.0\.1:\d+)/,
            );
            if (match?.[1]) listening(match[1]);
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
        const nativePath = record(await this.#api("GET", "/path"));
        if (
          typeof nativePath?.worktree !== "string" ||
          !path.isAbsolute(nativePath.worktree)
        )
          throw new Error("OpenCode did not report its permission path root");
        this.#worktree = nativePath.worktree;
        return server;
      } finally {
        this.#launching = undefined;
        this.#starting = undefined;
      }
    })());
  }

  /** OpenCode's configuration for this conversation, passed in its environment and never written to the workspace. */
  async #environment(): Promise<Record<string, string>> {
    const { context } = this;
    const skills = stagedSkillsRoot("opencode-cli", context.privateDirectory);
    const staged = context.skillDirectories.length
      ? await stageSkills(context.skillDirectories, skills)
      : [];
    const config = {
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      permission: {
        edit: "ask",
        read: "ask",
        glob: "ask",
        grep: "ask",
        list: "ask",
        webfetch: "allow",
        // Every native file/shell request reaches the shared policy first.
        bash: "ask",
        external_directory: "ask",
      },
      ...(staged.length ? { skills: { paths: [skills] } } : {}),
    };
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    };
    if (context.isolateUserConfig) {
      // A configuration folder of the session's own keeps the person's global settings, plugins and agents out; sign-ins live elsewhere.
      const config = path.join(context.privateDirectory, "opencode-config");
      await mkdir(path.join(config, "opencode"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.join(config, "opencode", "opencode.json"), "{}\n", {
        mode: 0o600,
      });
      Object.assign(env, {
        XDG_CONFIG_HOME: config,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      });
    }
    return env;
  }

  async #api(method: string, route: string, body?: unknown): Promise<unknown> {
    const server = this.#server;
    if (!server) throw new Error("OpenCode is not running");
    const response = await fetch(`${server.url}${route}`, {
      method,
      headers: {
        authorization: server.auth,
        "x-opencode-directory": encodeURIComponent(this.context.workspacePath),
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
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
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
      await this.#api("POST", "/mcp", {
        name: BRIDGE_SERVER_NAME,
        config: {
          type: "remote",
          url: bridge.url,
          enabled: true,
          oauth: false,
          headers: { Authorization: `Bearer ${bridge.token}` },
        },
      });
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
      const response = await fetch(`${server.url}/event`, {
        headers: {
          authorization: server.auth,
          "x-opencode-directory": encodeURIComponent(
            this.context.workspacePath,
          ),
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
                properties?: Record<string, unknown>;
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

  #event(event: { type?: string; properties?: Record<string, unknown> }): void {
    const turn = this.#turn;
    const properties = event.properties ?? {};
    // OpenCode emits a child's permission request with the child's session ID.
    // Verify ancestry through its API instead of dropping it and hanging task().
    if (event.type === "permission.asked") {
      if (turn) void this.#permission(turn, properties);
      else
        void this.#api(
          "POST",
          `/permission/${String(properties.id ?? "")}/reply`,
          { reply: "reject" },
        ).catch(() => {});
      return;
    }
    if (
      !turn ||
      (typeof properties.sessionID === "string" &&
        properties.sessionID !== this.#sessionId)
    )
      return;
    const sink = turn.sink;
    switch (event.type) {
      case "session.status": {
        const status = record(properties.status)?.type;
        if (status === "busy") turn.busy = true;
        return;
      }
      case "message.part.delta": {
        const partID = String(properties.partID ?? "");
        const part = turn.parts.get(partID);
        if (
          !part ||
          part.done ||
          properties.field !== "text" ||
          typeof properties.delta !== "string"
        )
          return;
        part.length += properties.delta.length;
        if (part.kind === "text") sink.text(partID, properties.delta);
        else sink.thinking(partID, properties.delta);
        return;
      }
      case "message.part.updated":
        this.#part(turn, record(properties.part) ?? {});
        return;
      case "message.updated": {
        const info = record(properties.info);
        if (info?.role === "user" && typeof info.id === "string")
          this.#userMessages.add(info.id);
        if (info?.role !== "assistant") return;
        const tokens = record(info.tokens);
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
        const error = record(info.error);
        if (error && record(error.data)?.message !== undefined)
          turn.error = String(record(error.data)?.message);
        else if (error)
          turn.error = String(error.name ?? "OpenCode reported an error");
        return;
      }
      case "session.compacted":
        if (!turn.manualCompaction) {
          sink.compaction("start");
          sink.compaction("end", {});
        }
        return;
      case "session.error": {
        const error = record(properties.error);
        turn.error = String(
          record(error?.data)?.message ??
            error?.name ??
            "OpenCode reported an error",
        );
        return;
      }
      case "session.idle": {
        if (!turn.busy && !turn.parts.size && !turn.tools.size && !turn.error)
          return;
        this.#turn = undefined;
        this.#bridge?.revoke();
        if (turn.signal.aborted) turn.resolve({ status: "aborted" });
        else if (turn.error && !/aborted/i.test(turn.error))
          turn.resolve({ status: "failed", error: turn.error });
        else turn.resolve({ status: "completed" });
        return;
      }
      default:
        return;
    }
  }

  #part(turn: OpenCodeTurn, part: Record<string, unknown>): void {
    const id = typeof part.id === "string" ? part.id : undefined;
    if (!id) return;
    const sink = turn.sink;
    if (part.type === "text" || part.type === "reasoning") {
      if (part.synthetic === true) return;
      const kind = part.type === "text" ? "text" : "reasoning";
      const text = typeof part.text === "string" ? part.text : "";
      let state = turn.parts.get(id);
      if (!state) {
        // A user message's own text comes back too; only the agent's parts belong to the turn.
        if (part.messageID && this.#userMessages.has(String(part.messageID)))
          return;
        state = { kind, length: 0, done: false };
        turn.parts.set(id, state);
      }
      if (state.done) return;
      if (text.length > state.length) {
        const delta = text.slice(state.length);
        state.length = text.length;
        if (kind === "text") sink.text(id, delta);
        else sink.thinking(id, delta);
      }
      if (record(part.time)?.end !== undefined) {
        state.done = true;
        if (kind === "text") sink.textDone(id, text);
        else sink.thinkingDone(id, text);
      }
      return;
    }
    if (part.type === "tool" && typeof part.callID === "string") {
      const state = record(part.state) ?? {};
      const callId = part.callID;
      // A pending call is still receiving its arguments.
      if (state.status === "pending") return;
      if (!turn.tools.has(callId)) {
        turn.tools.add(callId);
        const call = openCodeToolCall(
          String(part.tool ?? "tool"),
          record(state.input) ?? {},
        );
        sink.toolCall(callId, call.name, call.args);
      }
      if (state.status === "running") {
        sink.toolStarted(callId);
        return;
      }
      if (state.status !== "completed" && state.status !== "error") return;
      const tool = String(part.tool ?? "");
      const bridged = tool.startsWith(`${BRIDGE_SERVER_NAME}_`)
        ? this.#takeBridged(
            tool.slice(BRIDGE_SERVER_NAME.length + 1),
            state.input,
          )
        : undefined;
      if (bridged) sink.toolResult(callId, bridged.result, bridged.isError);
      else if (state.status === "completed")
        sink.toolResult(
          callId,
          textResult(typeof state.output === "string" ? state.output : ""),
          false,
        );
      else
        sink.toolResult(
          callId,
          textResult(
            typeof state.error === "string" ? state.error : "Tool failed",
          ),
          true,
        );
    }
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
    const id = String(request.id ?? "");
    if (
      typeof request.sessionID !== "string" ||
      !(await this.#belongsToSession(request.sessionID)) ||
      turn.signal.aborted ||
      this.#turn !== turn
    ) {
      await this.#api("POST", `/permission/${id}/reply`, {
        reply: "reject",
      }).catch(() => {});
      return;
    }
    const permission = String(request.permission ?? "");
    const patterns = Array.isArray(request.patterns)
      ? request.patterns.map(String)
      : [];
    const metadata = record(request.metadata) ?? {};
    // File permission patterns are relative to OpenCode's Git worktree,
    // which can be an ancestor of the app workspace. Search patterns are not paths.
    const filePermission = [
      "external_directory",
      "edit",
      "read",
      "list",
    ].includes(permission);
    const resolvePattern = (value: string) =>
      path.resolve(this.#worktree!, value);
    const command =
      typeof metadata.command === "string"
        ? metadata.command
        : permission === "bash"
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
        Array.isArray(request.always) &&
        request.always.length > 0 &&
        (file !== undefined || command !== undefined),
    };
    const callId =
      typeof record(request.tool)?.callID === "string"
        ? String(record(request.tool)!.callID)
        : undefined;
    let decision: ApprovalDecision;
    // A rejection with feedback lets OpenCode adjust and continue; a bare one stops its loop.
    let feedback: string | undefined;
    try {
      if (OPENCODE_OWN_PERMISSIONS.has(permission)) decision = "allow";
      else if (turn.readOnly && !OPENCODE_READ_PERMISSIONS.has(permission)) {
        decision =
          permission === "bash" &&
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
    await this.#api("POST", `/permission/${id}/reply`, {
      // Conversation grants are kept by OhMyGame for the exact request, never as a native pattern.
      reply: decision === "deny" ? "reject" : "once",
      ...(decision === "deny" && feedback ? { message: feedback } : {}),
    }).catch(() => {});
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
  "task",
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
