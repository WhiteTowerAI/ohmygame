import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import type { AgentUsageLimit } from "../../shared/contracts.js";
import type {
  NativeDriver,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
} from "./native-session.js";
import { AgentProcess, processFailure } from "./process.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";
import { EXTERNAL_MCP_SERVER_NAME } from "../../shared/external-mcp.js";
import {
  BridgeResults,
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
import { sessionCaches } from "./environment.js";
import { NativeSessionExpiredError } from "./native-session.js";
import { cliProbeError, runtimeStartupError } from "./compatibility.js";

const CONTROL_TIMEOUT_MS = 30_000;

/**
 * Claude Code can launch subagents and shells in the background, and
 * schedule prompts, that report after its turn has ended. A turn here ends
 * with Claude's result, so later reports would have no turn to land in:
 * keep that work in the foreground.
 */
const FOREGROUND_ONLY = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_DISABLE_CRON: "1",
};

interface PendingTurn {
  sink: NativeTurnSink;
  resolve: (outcome: NativeTurnOutcome) => void;
  signal: AbortSignal;
  blocks: Map<string, "text" | "thinking">;
  streamed: Set<string>;
  /** Tool calls OhMyGame allowed, which Claude Code runs next; one may be allowed before its call is reported. */
  started: Set<string>;
  readOnly: boolean;
  /** The latest model request's usage, which is what the context holds; the result's usage adds up every request. */
  requestUsage?: Record<string, unknown>;
}

/**
 * Claude Code over its stream-json protocol, with one long-lived process per
 * session. Messages go in on stdin, which stays open for later turns. OhMyGame's tools are an
 * in-process MCP server answered over the same pipe, and permission requests
 * come back on it too: no port, no token, no file in the workspace.
 */
export class ClaudeCodeDriver implements NativeDriver {
  #process?: AgentProcess;
  #starting?: Promise<AgentProcess>;
  #turn?: PendingTurn;
  #sessionId?: string;
  #limits: AgentUsageLimit[] = [];
  #permissionMode?: string;
  #controls = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (cause: Error) => void;
    }
  >();
  #results = new BridgeResults();
  #messageId?: string;
  #compacting?: { tokensBefore?: number };
  #disposed = false;
  #hookDecisions = new Map<string, ApprovalDecision>();

  constructor(private readonly context: DriverContext) {
    this.#sessionId = context.resume;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    if (signal.aborted) return { status: "aborted" };
    let child: AgentProcess;
    try {
      child = await this.#start(input.readOnly);
    } catch (cause) {
      if (signal.aborted) return { status: "aborted" };
      if (
        this.context.resume &&
        /no (?:conversation|session) found|session (?:id )?.*(?:not found|does not exist)/i.test(
          String(cause),
        )
      )
        throw new NativeSessionExpiredError(String(cause));
      throw runtimeStartupError(cause);
    }
    if (signal.aborted) return { status: "aborted" };
    await this.#setPermissionMode(input.readOnly ? "default" : "acceptEdits");
    if (signal.aborted) return { status: "aborted" };
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      this.#turn = {
        sink,
        resolve,
        signal,
        blocks: new Map(),
        streamed: new Set(),
        started: new Set(),
        readOnly: input.readOnly,
      };
      try {
        child.write(userMessage(input));
      } catch (cause) {
        this.#turn = undefined;
        resolve({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
    if (
      outcome.status === "failed" &&
      this.context.resume &&
      /no (?:conversation|session) found|session (?:id )?.*(?:not found|does not exist)/i.test(
        outcome.error,
      )
    )
      throw new NativeSessionExpiredError(outcome.error);
    return outcome;
  }

  async interrupt(): Promise<void> {
    if (!this.#process?.running || !this.#turn) return;
    await this.#control({ subtype: "interrupt" }).catch(() => {});
  }

  async compact(
    sink: NativeTurnSink,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<void> {
    sink.compaction("start");
    const compacting: { tokensBefore?: number } = {};
    this.#compacting = compacting;
    let outcome: NativeTurnOutcome = { status: "aborted" };
    try {
      outcome = await this.runTurn(
        {
          text: `/compact${instructions ? ` ${instructions}` : ""}`,
          images: [],
          readOnly: false,
        },
        sink,
        signal,
      );
    } finally {
      this.#compacting = undefined;
      sink.compaction(
        "end",
        outcome.status === "failed"
          ? { error: outcome.error }
          : compacting.tokensBefore !== undefined
            ? { tokensBefore: compacting.tokensBefore }
            : {},
      );
    }
    if (outcome.status === "failed") throw new Error(outcome.error);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const control of this.#controls.values())
      control.reject(new Error("The agent session was closed"));
    this.#controls.clear();
    const child = this.#process;
    await child?.stop();
    this.#process = undefined;
  }

  async #start(readOnly: boolean): Promise<AgentProcess> {
    if (this.#process?.running) return this.#process;
    return (this.#starting ??= (async () => {
      try {
        const args = await this.#arguments(readOnly);
        if (this.#disposed) throw new Error("The agent session was closed");
        const child = new AgentProcess({
          binaryPath: this.context.binaryPath,
          args,
          cwd: this.context.workspacePath,
          env: {
            ...this.context.env,
            ...FOREGROUND_ONLY,
            // Sandboxed installs cannot write the home folder's caches.
            ...(this.context.policy.fullAccess
              ? {}
              : sessionCaches(commandTemporary(this.context))),
          },
          processDirectory: this.context.processDirectory,
          onLine: (line) => this.#receive(line),
          onExit: (code, signal, stderr) =>
            this.#exited(child, code, signal, stderr),
        });
        this.#process = child;
        this.#permissionMode = readOnly ? "default" : "acceptEdits";
        await this.#control({
          subtype: "initialize",
          sdkMcpServers: [BRIDGE_SERVER_NAME],
          hooks: { PreToolUse: [{ hookCallbackIds: ["ohmygame-policy"] }] },
        });
        if (this.#disposed) throw new Error("The agent session was closed");
        return child;
      } finally {
        this.#starting = undefined;
      }
    })());
  }

  async #arguments(readOnly: boolean): Promise<string[]> {
    const { context } = this;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      readOnly ? "default" : "acceptEdits",
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          [BRIDGE_SERVER_NAME]: { type: "sdk", name: BRIDGE_SERVER_NAME },
        },
      }),
      "--model",
      context.model,
      "--append-system-prompt",
      context.instructions,
    ];
    if (context.reasoningLevel) args.push("--effort", context.reasoningLevel);
    if (context.isolateUserConfig)
      args.push("--setting-sources", "", "--strict-mcp-config");
    // The person's own configuration may connect Claude Code to OhMyGame from outside.
    else args.push("--disallowedTools", `mcp__${EXTERNAL_MCP_SERVER_NAME}`);
    // Flag settings apply whichever sources load, so the sandbox holds with
    // the person's own configuration too. Full access runs without it.
    if (!context.policy.fullAccess) {
      await mkdir(commandTemporary(context), { recursive: true, mode: 0o700 });
      args.push("--settings", JSON.stringify(claudeSandboxSettings(context)));
    }
    if (context.skillDirectories.length) {
      // Skills reach Claude Code as a plugin of this session's own.
      const skills = stagedSkillsRoot(
        "claude-code-cli",
        context.privateDirectory,
      );
      const plugin = path.dirname(skills);
      await mkdir(path.join(plugin, ".claude-plugin"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        path.join(plugin, ".claude-plugin", "plugin.json"),
        JSON.stringify({
          name: "ohmygame",
          version: "1.0.0",
          description: "OhMyGame Skills for this project",
        }),
      );
      if ((await stageSkills(context.skillDirectories, skills)).length)
        args.push("--plugin-dir", plugin);
    }
    if (this.#sessionId) args.push("--resume", this.#sessionId);
    else {
      this.#sessionId = randomUUID();
      args.push("--session-id", this.#sessionId);
    }
    return args;
  }

  /**
   * Planning runs in Claude's default mode, not its own plan mode: that mode
   * steers Claude to write a plan file and call ExitPlanMode, while OhMyGame
   * takes the plan through update_plan. The hook keeps the turn read-only,
   * and default mode sends any edit the hook did not see to can_use_tool.
   */
  async #setPermissionMode(mode: "default" | "acceptEdits"): Promise<void> {
    if (this.#permissionMode === mode) return;
    await this.#control({ subtype: "set_permission_mode", mode });
    this.#permissionMode = mode;
  }

  #control(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.#process;
    if (!child?.running)
      return Promise.reject(new Error("Claude Code is not running"));
    const id = `ohmygame-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#controls.delete(id);
        reject(
          new Error(`Claude Code did not answer ${String(request.subtype)}`),
        );
      }, CONTROL_TIMEOUT_MS);
      this.#controls.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (cause) => {
          clearTimeout(timer);
          reject(cause);
        },
      });
      child.write({ type: "control_request", request_id: id, request });
    });
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const turn = this.#turn;
    switch (message.type) {
      case "control_response": {
        const response = record(message.response);
        const pending = this.#controls.get(String(response?.request_id));
        if (!pending) return;
        this.#controls.delete(String(response?.request_id));
        if (response?.subtype === "error")
          pending.reject(
            new Error(
              String(response.error ?? "Claude Code refused the request"),
            ),
          );
        else pending.resolve(record(response?.response) ?? {});
        return;
      }
      case "control_request":
        void this.#answerControl(
          String(message.request_id),
          record(message.request) ?? {},
        );
        return;
      case "system": {
        if (typeof message.session_id === "string" && message.session_id) {
          this.#sessionId = message.session_id;
          turn?.sink.nativeSession(message.session_id);
        }
        if (message.subtype === "compact_boundary" && turn) {
          const metadata = record(message.compact_metadata);
          const tokensBefore =
            typeof metadata?.pre_tokens === "number"
              ? metadata.pre_tokens
              : undefined;
          // A compaction that was asked for is reported once it is over; one Claude Code started itself, here.
          if (this.#compacting) this.#compacting.tokensBefore = tokensBefore;
          else {
            turn.sink.compaction("start");
            turn.sink.compaction(
              "end",
              tokensBefore !== undefined ? { tokensBefore } : {},
            );
          }
        }
        return;
      }
      case "stream_event":
        if (turn && message.parent_tool_use_id == null)
          this.#streamEvent(turn, record(message.event) ?? {});
        return;
      case "assistant":
        if (turn && message.parent_tool_use_id == null)
          this.#assistant(turn, record(message.message) ?? {});
        return;
      case "user":
        if (turn && message.parent_tool_use_id == null)
          this.#toolResults(turn, record(message.message) ?? {});
        return;
      case "result":
        this.#result(message);
        return;
      case "rate_limit_event": {
        // An event may carry one window; the others keep their last value.
        const reported = claudeLimits(record(message.rate_limit_info));
        if (!reported.length) return;
        const ids = new Set(reported.map((limit) => limit.id));
        this.#limits = [
          ...this.#limits.filter((limit) => !ids.has(limit.id)),
          ...reported,
        ].sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
        turn?.sink.limits?.(this.#limits);
        return;
      }
      default:
        return;
    }
  }

  #streamEvent(turn: PendingTurn, event: Record<string, unknown>): void {
    const messageId = this.#messageId ?? "message";
    if (event.type === "message_start") {
      this.#messageId = String(record(event.message)?.id ?? randomUUID());
      return;
    }
    const index = typeof event.index === "number" ? event.index : -1;
    const key = `${messageId}:${index}`;
    if (event.type === "content_block_start") {
      const block = record(event.content_block);
      if (block?.type === "text" || block?.type === "thinking")
        turn.blocks.set(key, block.type);
    } else if (event.type === "content_block_delta") {
      const delta = record(event.delta);
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        turn.streamed.add(key);
        turn.sink.text(key, delta.text);
      } else if (
        delta?.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        turn.streamed.add(key);
        turn.sink.thinking(key, delta.thinking);
      }
    } else if (event.type === "content_block_stop") {
      const kind = turn.blocks.get(key);
      if (kind === "text") turn.sink.textDone(key);
      else if (kind === "thinking") turn.sink.thinkingDone(key);
      turn.blocks.delete(key);
    }
  }

  #assistant(turn: PendingTurn, message: Record<string, unknown>): void {
    const id = String(message.id ?? this.#messageId ?? randomUUID());
    turn.requestUsage = record(message.usage) ?? turn.requestUsage;
    const content = Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [];
    content.forEach((block, index) => {
      const key = `${id}:${index}`;
      // Text that streamed in is already there; text that did not is added whole.
      if (
        block.type === "text" &&
        typeof block.text === "string" &&
        !turn.streamed.has(key)
      )
        turn.sink.textDone(key, block.text);
      else if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        !turn.streamed.has(key)
      )
        turn.sink.thinkingDone(key, block.thinking);
      else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        !HIDDEN_TOOLS.has(String(block.name))
      ) {
        const call = claudeToolCall(
          String(block.name ?? "tool"),
          record(block.input) ?? {},
        );
        turn.sink.toolCall(block.id, call.name, call.args);
        if (turn.started.has(block.id)) turn.sink.toolStarted(block.id);
      }
    });
  }

  #toolResults(turn: PendingTurn, message: Record<string, unknown>): void {
    const content = Array.isArray(message.content)
      ? (message.content as Array<Record<string, unknown>>)
      : [];
    for (const block of content) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string")
        continue;
      const bridged = this.#results.take(block.tool_use_id);
      if (bridged)
        turn.sink.toolResult(
          block.tool_use_id,
          bridged.result,
          bridged.isError,
        );
      else
        turn.sink.toolResult(
          block.tool_use_id,
          textResult(block.content),
          block.is_error === true,
        );
    }
  }

  #result(message: Record<string, unknown>): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    this.#hookDecisions.clear();
    const usage = turn.requestUsage ?? record(message.usage);
    if (usage) {
      const models = record(message.modelUsage);
      const contextWindow = models
        ? Object.values(models)
            .map((value) => record(value)?.contextWindow)
            .find((value): value is number => typeof value === "number")
        : undefined;
      const lastInput =
        number(usage.input_tokens) +
        number(usage.cache_read_input_tokens) +
        number(usage.cache_creation_input_tokens);
      turn.sink.usage(
        {
          input: number(usage.input_tokens),
          output: number(usage.output_tokens),
          cacheRead: number(usage.cache_read_input_tokens),
          cacheWrite: number(usage.cache_creation_input_tokens),
        },
        contextWindow,
        lastInput || undefined,
      );
    }
    if (turn.signal.aborted) {
      turn.resolve({ status: "aborted" });
      return;
    }
    if (
      message.is_error === true ||
      (typeof message.subtype === "string" && message.subtype !== "success")
    ) {
      const text =
        typeof message.result === "string" && message.result
          ? message.result
          : Array.isArray(message.errors)
            ? message.errors.join("\n")
            : `Claude Code ended the turn: ${String(message.subtype)}`;
      turn.resolve({ status: "failed", error: text });
      return;
    }
    turn.resolve({ status: "completed" });
  }

  async #answerControl(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = await this.#control_response(request);
    } catch (cause) {
      if (this.#process?.running)
        this.#process.write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      return;
    }
    if (this.#process?.running)
      this.#process.write({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      });
  }

  async #control_response(
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (request.subtype === "hook_callback") {
      if (request.callback_id !== "ohmygame-policy")
        throw new Error("Unknown hook callback");
      const input = record(request.input) ?? {};
      const turn = this.#turn;
      const tool = String(input.tool_name ?? "");
      const callId =
        typeof request.tool_use_id === "string"
          ? request.tool_use_id
          : undefined;
      const { decision, reason } =
        turn && !turn.signal.aborted
          ? await this.#judge(
              turn,
              tool,
              record(input.tool_input) ?? {},
              input,
              callId,
            )
          : { decision: "deny" as const, reason: "No turn is running" };
      if (callId) this.#hookDecisions.set(callId, decision);
      if (turn && callId && decision !== "deny") this.#started(turn, callId);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision === "deny" ? "deny" : "allow",
          permissionDecisionReason:
            decision === "deny" ? reason : "Approved by OhMyGame",
        },
      };
    }
    if (request.subtype === "mcp_message") {
      const turn = this.#turn;
      if (!turn || turn.signal.aborted) throw new Error("No turn is running");
      const answer = await this.context.bridge.handle(
        request.message,
        (call, outcome) => this.#results.record(call.callId, outcome),
        turn.signal,
      );
      return { mcp_response: answer ?? { jsonrpc: "2.0", result: {}, id: 0 } };
    }
    if (request.subtype === "can_use_tool") {
      const input = record(request.input) ?? {};
      const turn = this.#turn;
      if (!turn || turn.signal.aborted)
        return { behavior: "deny", message: "No turn is running" };
      const mcp = record(request.mcp_server);
      // OhMyGame's own tools need no permission; the daemon runs them.
      if (mcp?.name === BRIDGE_SERVER_NAME)
        return { behavior: "allow", updatedInput: input };
      const toolName = String(request.tool_name ?? "tool");
      const toolId =
        typeof request.tool_use_id === "string"
          ? request.tool_use_id
          : undefined;
      const previous = toolId ? this.#hookDecisions.get(toolId) : undefined;
      if (toolId) this.#hookDecisions.delete(toolId);
      const { decision, reason } = previous
        ? { decision: previous, reason: "This operation was not allowed." }
        : await this.#judge(turn, toolName, input, request, toolId);
      if (decision === "deny") return { behavior: "deny", message: reason };
      if (toolId) this.#started(turn, toolId);
      return { behavior: "allow", updatedInput: input };
    }
    // Nothing else is asked of a host here; an empty success keeps the CLI going.
    return {};
  }

  /**
   * Claude Code reports a tool call and then its result, with nothing when the
   * tool begins. It runs a tool as soon as OhMyGame allows it, so that is when
   * the call is shown as running: a long command or build is visible, and can
   * be stopped, while it runs.
   */
  #started(turn: PendingTurn, callId: string): void {
    turn.started.add(callId);
    turn.sink.toolStarted(callId);
  }

  /** The hook and the permission callback answer the same question the same way. */
  async #judge(
    turn: PendingTurn,
    tool: string,
    args: Record<string, unknown>,
    request: Record<string, unknown>,
    callId: string | undefined,
  ): Promise<{ decision: ApprovalDecision; reason: string }> {
    if (
      tool.startsWith(`mcp__${BRIDGE_SERVER_NAME}__`) ||
      CLAUDE_OWN_TOOLS.has(tool)
    )
      return { decision: "allow", reason: "Approved by OhMyGame" };
    if (tool === "ExitPlanMode")
      return {
        decision: "deny",
        reason:
          "OhMyGame reviews plans itself: record the plan with update_plan and end your reply.",
      };
    const details = claudeApproval(
      tool,
      args,
      request,
      this.context.workspacePath,
    );
    if (turn.readOnly && !CLAUDE_READ_TOOLS.has(tool)) {
      // Current CLIs search with Bash rather than Glob/Grep, so planning may
      // run the read commands the policy allows without asking, and no other.
      const readCommand =
        tool === "Bash" &&
        judgeApproval(details, planningPolicy(this.context.policy)) === "allow";
      return readCommand
        ? { decision: "allow", reason: "Approved by OhMyGame" }
        : {
            decision: "deny",
            reason: PLANNING_DENIAL,
          };
    }
    const decision = await decideApproval(details, this.context, turn.sink, {
      ...(callId ? { callId } : {}),
      signal: turn.signal,
    });
    return { decision, reason: "This operation was not allowed." };
  }

  #exited(
    child: AgentProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    if (this.#process === child) this.#process = undefined;
    for (const control of this.#controls.values())
      control.reject(
        cliProbeError(
          "Claude Code",
          processFailure("Claude Code", code, signal, stderr),
        ),
      );
    this.#controls.clear();
    const turn = this.#turn;
    this.#turn = undefined;
    if (!turn) return;
    turn.resolve(
      turn.signal.aborted || this.#disposed
        ? { status: "aborted" }
        : {
            status: "failed",
            error: processFailure("Claude Code", code, signal, stderr),
          },
    );
  }
}

/** Claude Code's own bookkeeping, such as loading the schemas of deferred tools, which is not work to show. */
const HIDDEN_TOOLS = new Set(["ToolSearch"]);

/**
 * Claude Code tools that touch no file and run no command: its task list,
 * Skill loading, subagents (whose own tool calls come through this hook),
 * background shell output and stopping, web research and its MCP resource
 * readers. Older and newer CLIs name some of these differently.
 * Asking about each would interrupt the person for the agent's bookkeeping.
 */
const CLAUDE_OWN_TOOLS = new Set([
  "ToolSearch",
  "TodoWrite",
  "Skill",
  "Task",
  "Agent",
  "BashOutput",
  "KillShell",
  "KillBash",
  "TaskStop",
  "ListAgents",
  "WebSearch",
  "WebFetch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/** File tools a planning turn may use; the shared policy still checks their paths. */
const CLAUDE_READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * Claude Code's own sandbox confines the commands it runs at the operating
 * system level: what the shell-text policy cannot see, such as a glob or a
 * workspace link that resolves into a protected folder, is refused by the
 * OS. Protected roots are unreadable; the workspace and this session's
 * staged Skills stay readable even when they lie inside one, and writes keep
 * the sandbox's default of the workspace and temporary files. Commands
 * cannot opt out, and OhMyGame still decides which ones run. Where the
 * sandbox is not available, such as Linux without bubblewrap, the strict
 * approval policy applies. When the policy relies on confinement, startup
 * must fail instead of silently running commands without it.
 */
/** Where sandboxed commands keep package caches, in the session's private folder. */
function commandTemporary(context: DriverContext): string {
  return path.join(context.privateDirectory, "tmp");
}

export function claudeSandboxSettings(context: DriverContext): {
  sandbox: Record<string, unknown>;
} {
  const workspace = canonicalPath(context.workspacePath);
  const temporary = canonicalPath(commandTemporary(context));
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: context.policy.sandboxedCommands === true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: context.policy.neverTouch
          .map(canonicalPath)
          .filter((root) => root !== workspace),
        allowRead: [
          workspace,
          temporary,
          ...(context.policy.readablePaths ?? []).map(canonicalPath),
        ],
        // Installs fill the package caches; those in the home folder are not writable here.
        allowWrite: [temporary],
      },
      // Builds and installs need the network, as they do for OhMyGame's own agent.
      network: { allowedDomains: ["*"] },
    },
  };
}

function userMessage(input: NativeTurnInput): Record<string, unknown> {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: input.text },
        ...input.images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.data,
          },
        })),
      ],
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}

/** OhMyGame's tools by their own names; Claude Code's file and shell tools by Pi's. */
export function claudeToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  const prefix = `mcp__${BRIDGE_SERVER_NAME}__`;
  if (name.startsWith(prefix))
    return { name: name.slice(prefix.length), args: input };
  return piToolCall(name, input);
}

function claudeApproval(
  tool: string,
  input: Record<string, unknown>,
  request: Record<string, unknown>,
  workspace?: string,
): ApprovalRequestDetails {
  const file =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : typeof request.blocked_path === "string"
          ? request.blocked_path
          : typeof input.path === "string"
            ? input.path
            : ["Glob", "Grep", "LS"].includes(tool)
              ? workspace
              : undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  const kind =
    command !== undefined
      ? "command"
      : file
        ? "file"
        : tool.startsWith("mcp__")
          ? "tool"
          : "other";
  return {
    kind,
    tool,
    ...(typeof request.title === "string"
      ? { title: request.title }
      : typeof request.display_name === "string"
        ? { title: request.display_name }
        : {}),
    ...(command !== undefined ? { command } : {}),
    ...(file ? { path: file } : {}),
    ...(typeof request.decision_reason === "string"
      ? { reason: stripAnsi(request.decision_reason) }
      : {}),
    canAllowSession: request.suppress_always_allow_rule !== true,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const CLAUDE_WINDOWS: Record<string, number> = {
  five_hour: 300,
  seven_day: 7 * 24 * 60,
};

/**
 * Claude Code's subscription windows from a `rate_limit_event`: every window
 * it tracks when it reports them, otherwise the one currently limiting.
 * Utilization is a fraction of the window, and may pass 1.
 */
export function claudeLimits(
  info: Record<string, unknown> | undefined,
): AgentUsageLimit[] {
  const limit = (
    name: string,
    utilization: unknown,
    resetsAt: unknown,
  ): AgentUsageLimit[] =>
    typeof utilization === "number" && CLAUDE_WINDOWS[name]
      ? [
          {
            id: `claude/${name}`,
            usedPercent: Math.max(0, Math.min(100, utilization * 100)),
            windowMinutes: CLAUDE_WINDOWS[name],
            ...(typeof resetsAt === "number" ? { resetsAt } : {}),
          },
        ]
      : [];
  const windows = record(info?.unifiedWindows);
  const tracked = Object.keys(CLAUDE_WINDOWS).flatMap((name) => {
    const window = record(windows?.[name]);
    return limit(name, window?.utilization, window?.resetsAt);
  });
  return tracked.length
    ? tracked
    : limit(String(info?.rateLimitType), info?.utilization, info?.resetsAt);
}
