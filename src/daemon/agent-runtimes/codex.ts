import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  FULL_ACCESS_PERMISSION_MODES,
  isAgentPermissionMode,
  type ApprovalDecision,
  type ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import type {
  NativeDriver,
  NativeToolResult,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
} from "./native-session.js";
import {
  CodexAppServer,
  codexLimits,
  requireCodexPermissionProfile,
} from "./codex-app-server.js";
import {
  BridgeResults,
  number,
  PLANNING_DENIAL,
  record,
  textResult,
  type DriverContext,
} from "./driver-context.js";
import {
  acquireCodexServer,
  type CodexServerLease,
} from "./codex-server-pool.js";
import { NativeSessionExpiredError } from "./native-session.js";
import type { AgentContextUsage } from "../../shared/contracts.js";
import { runtimeStartupError } from "./compatibility.js";
import { importCodexImage } from "./codex-images.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";
import { EXTERNAL_MCP_SERVER_NAME } from "../../shared/external-mcp.js";

/** A turn on a shared server must stop on its own: the process outlives the conversation. */
const INTERRUPT_TIMEOUT_MS = 5_000;
const TOOL_PREFIX = `${BRIDGE_SERVER_NAME}_`;

interface CodexTurn {
  sink: NativeTurnSink;
  signal: AbortSignal;
  resolve: (outcome: NativeTurnOutcome) => void;
  turnId?: string;
  error?: string;
  readOnly?: boolean;
  images: Map<string, Promise<void>>;
  imageError?: string;
  finishing?: boolean;
}

/**
 * Codex through its app server: one thread per conversation, one turn per
 * message. OhMyGame's tools are the thread's dynamic tools, answered over the
 * same pipe. Codex's built-in permission profiles and approval policy decide
 * what it may do and what it asks; OhMyGame shows the question and returns
 * the person's answer.
 */
export class CodexDriver implements NativeDriver {
  #disposed = false;
  readonly #privateKey = `private-${randomUUID()}`;
  /** The Codex permission profile the person chose for work; planning uses its read-only one. */
  readonly #writeProfile: string;
  #limits: NonNullable<AgentContextUsage["limits"]> = [];
  #lease?: CodexServerLease;
  #starting?: Promise<CodexAppServer>;
  #threadId?: string;
  #turn?: CodexTurn;
  #bridged = new BridgeResults();

  constructor(private readonly context: DriverContext) {
    this.#threadId = context.resume;
    this.#writeProfile = isAgentPermissionMode(
      "codex-cli",
      context.permissionMode,
    )
      ? context.permissionMode
      : FULL_ACCESS_PERMISSION_MODES["codex-cli"];
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    if (signal.aborted) return { status: "aborted" };
    let server: CodexAppServer;
    let threadId: string;
    try {
      server = await this.#start();
      if (signal.aborted) return { status: "aborted" };
      threadId = await this.#thread(server, sink);
      if (this.#limits.length) sink.limits?.(this.#limits);
      if (signal.aborted) return { status: "aborted" };
    } catch (cause) {
      if (cause instanceof NativeSessionExpiredError) throw cause;
      if (signal.aborted) return { status: "aborted" };
      return {
        status: "failed",
        error: runtimeStartupError(cause).message,
      };
    }
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = {
        sink,
        signal,
        resolve,
        readOnly: input.readOnly,
        images: new Map(),
      };
      this.#turn = turn;
      server
        .request<{ turn?: { id?: string } }>("turn/start", {
          threadId,
          input: codexInput(input),
          ...(this.context.reasoningLevel
            ? { effort: this.context.reasoningLevel }
            : {}),
          model: this.context.model,
          permissions: input.readOnly ? READ_PROFILE : this.#writeProfile,
        })
        .then(
          (response) => {
            turn.turnId ??= response.turn?.id;
          },
          (cause) => {
            if (this.#turn !== turn) return;
            this.#turn = undefined;
            resolve({
              status: "failed",
              error: cause instanceof Error ? cause.message : String(cause),
            });
          },
        );
    });
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn?.turnId || !this.#lease || !this.#threadId) return;
    await this.#lease.server
      .request(
        "turn/interrupt",
        { threadId: this.#threadId, turnId: turn.turnId },
        INTERRUPT_TIMEOUT_MS,
      )
      .catch(() => {});
  }

  async compact(sink: NativeTurnSink, signal: AbortSignal): Promise<void> {
    const server = await this.#start();
    const threadId = await this.#thread(server, sink);
    sink.compaction("start");
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = { sink, signal, resolve, images: new Map() };
      this.#turn = turn;
      server.request("thread/compact/start", { threadId }).catch((cause) => {
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

  /**
   * Lets go of the shared server. Other conversations may still use it, so a
   * turn of this thread is interrupted rather than ended with the process;
   * the server stops with its last conversation.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.interrupt();
    const turn = this.#turn;
    this.#turn = undefined;
    const lease = this.#lease;
    this.#lease = undefined;
    await lease?.release();
    turn?.resolve({ status: "aborted" });
  }

  async #start(): Promise<CodexAppServer> {
    if (this.#disposed) throw new Error("The agent session was closed");
    if (this.#lease?.server.process.running) return this.#lease.server;
    return (this.#starting ??= (async () => {
      try {
        const shared = this.context.codexServer;
        const lease = await acquireCodexServer(
          {
            // Without a shared identity the server is this session's alone.
            key: shared?.key ?? this.#privateKey,
            directory: shared?.directory ?? this.context.privateDirectory,
            shared: Boolean(shared),
            binaryPath: this.context.binaryPath,
            env: this.context.env,
            processDirectory: this.context.processDirectory,
            skillDirectories: this.context.skillDirectories,
          },
          {
            notification: (method, params) =>
              this.#notification(method, params),
            request: (method, params) => this.#request(method, params),
            exit: (failure) => {
              this.#lease = undefined;
              const turn = this.#turn;
              this.#turn = undefined;
              turn?.resolve(
                turn.signal.aborted
                  ? { status: "aborted" }
                  : { status: "failed", error: failure },
              );
            },
          },
          codexLimits,
        );
        if (this.#disposed) {
          await lease.release();
          throw new Error("The agent session was closed");
        }
        this.#lease = lease;
        this.#limits = lease.limits;
        return lease.server;
      } finally {
        this.#starting = undefined;
      }
    })());
  }

  async #thread(server: CodexAppServer, sink: NativeTurnSink): Promise<string> {
    const settings = {
      cwd: this.context.workspacePath,
      // Codex asks when a command needs more than its sandbox allows; full access never asks.
      approvalPolicy:
        this.#writeProfile === ":danger-full-access" ? "never" : "on-request",
      permissions: this.#writeProfile,
      model: this.context.model,
      developerInstructions: this.context.instructions,
      config: await codexConfig(server, this.context.workspacePath),
    };
    if (this.#threadId) {
      try {
        const resumed = await server.request<{
          thread?: { id?: string };
          activePermissionProfile?: { id?: string };
        }>("thread/resume", { threadId: this.#threadId, ...settings });
        requireCodexPermissionProfile(resumed, this.#writeProfile);
        const id = resumed.thread?.id ?? this.#threadId;
        this.#threadId = id;
        this.#lease?.bind(id);
        sink.nativeSession(id);
        return id;
      } catch (cause) {
        if (
          /thread (?:not found|.*does not exist)|no rollout found|failed to (?:load|find).*rollout|not found.*thread/i.test(
            String(cause),
          )
        )
          throw new NativeSessionExpiredError(String(cause));
        throw cause;
      }
    }
    // Dynamic tools are fixed when the thread starts, including in planning.
    // Names such as mcp are reserved by Codex, so prefix the host's tools.
    const tools = this.context.bridge.list("all").map((tool) => ({
      type: "function",
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const started = await server.request<{
      thread?: { id?: string };
      activePermissionProfile?: { id?: string };
    }>("thread/start", { ...settings, dynamicTools: tools });
    requireCodexPermissionProfile(started, this.#writeProfile);
    const id = started.thread?.id;
    if (!id) throw new Error("Codex did not start a thread");
    this.#threadId = id;
    this.#lease?.bind(id);
    sink.nativeSession(id);
    return id;
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      this.#limits = codexLimits(params);
      this.#turn?.sink.limits?.(this.#limits);
      return;
    }
    const turn = this.#turn;
    if (!turn) return;
    if (typeof params.turnId === "string") turn.turnId ??= params.turnId;
    const sink = turn.sink;
    switch (method) {
      case "turn/started":
        turn.turnId ??= String(record(params.turn)?.id ?? "");
        return;
      case "item/agentMessage/delta":
        if (
          typeof params.itemId === "string" &&
          typeof params.delta === "string"
        )
          sink.text(params.itemId, params.delta);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        if (
          typeof params.itemId === "string" &&
          typeof params.delta === "string"
        )
          sink.thinking(params.itemId, params.delta);
        return;
      case "item/started":
        this.#itemStarted(sink, record(params.item) ?? {});
        return;
      case "item/completed":
        this.#itemCompleted(sink, record(params.item) ?? {});
        return;
      case "item/commandExecution/outputDelta":
        // The whole output comes with the completed item; streamed output is not repeated in the record.
        return;
      case "thread/tokenUsage/updated": {
        // `total` adds up the whole thread; `last` is the latest request,
        // which is what the context holds and what a stored message records.
        const usage = record(params.tokenUsage);
        const last = record(usage?.last);
        if (last) {
          sink.usage(
            {
              input: number(last.inputTokens) - number(last.cachedInputTokens),
              output: number(last.outputTokens),
              cacheRead: number(last.cachedInputTokens),
              cacheWrite: number(last.cacheWriteInputTokens),
            },
            typeof usage?.modelContextWindow === "number"
              ? usage.modelContextWindow
              : undefined,
            number(last.inputTokens) + number(last.outputTokens),
          );
        }
        return;
      }
      case "thread/started":
        if (typeof record(params.thread)?.id === "string")
          sink.nativeSession(String(record(params.thread)!.id));
        return;
      case "error": {
        const error = record(params.error);
        if (params.willRetry !== true) turn.error = codexError(error?.message);
        return;
      }
      case "turn/completed": {
        if (!turn.finishing) {
          turn.finishing = true;
          void this.#completeTurn(turn, record(params.turn) ?? {});
        }
        return;
      }
      default:
        return;
    }
  }

  async #completeTurn(
    turn: CodexTurn,
    completed: Record<string, unknown>,
  ): Promise<void> {
    // Image imports must reach the shared transcript before checkpoints and turn-end are recorded.
    await Promise.all(turn.images.values());
    if (this.#turn !== turn) return;
    this.#turn = undefined;
    if (completed.status === "interrupted" || turn.signal.aborted)
      turn.resolve({ status: "aborted" });
    else if (completed.status === "failed" || turn.imageError)
      turn.resolve({
        status: "failed",
        error:
          turn.imageError ||
          codexError(record(completed.error)?.message) ||
          turn.error ||
          "Codex could not finish the turn",
      });
    else turn.resolve({ status: "completed" });
  }

  #itemStarted(sink: NativeTurnSink, item: Record<string, unknown>): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
      case "imageGeneration":
        sink.toolCall(id, "generate_image", {
          source: "codex",
          ...(typeof item.revisedPrompt === "string"
            ? { prompt: item.revisedPrompt }
            : {}),
        });
        sink.toolStarted(id);
        return;
      case "commandExecution":
        sink.toolCall(id, "bash", { command: commandText(item.command) });
        sink.toolStarted(id);
        return;
      case "fileChange": {
        const changes = Array.isArray(item.changes)
          ? (item.changes as Array<Record<string, unknown>>)
          : [];
        sink.toolCall(id, "edit", {
          ...(typeof changes[0]?.path === "string"
            ? { path: changes[0].path }
            : {}),
          ...(changes.length > 1
            ? { files: changes.map((change) => change.path) }
            : {}),
        });
        sink.toolStarted(id);
        return;
      }
      case "dynamicToolCall":
        sink.toolCall(
          id,
          this.#bridgeToolName(item.tool ?? "tool"),
          record(item.arguments) ?? {},
        );
        sink.toolStarted(id);
        return;
      case "mcpToolCall":
        sink.toolCall(
          id,
          `${String(item.server ?? "mcp")}__${String(item.tool ?? "tool")}`,
          record(item.arguments) ?? {},
        );
        sink.toolStarted(id);
        return;
      case "webSearch":
        sink.toolCall(id, "web_search", { query: String(item.query ?? "") });
        sink.toolStarted(id);
        return;
      case "contextCompaction":
        sink.compaction("start");
        return;
      default:
        return;
    }
  }

  #itemCompleted(sink: NativeTurnSink, item: Record<string, unknown>): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
      case "imageGeneration": {
        const turn = this.#turn;
        if (
          !turn ||
          turn.finishing ||
          turn.signal.aborted ||
          turn.images.has(id)
        )
          return;
        // Some versions only emit the completed item. The sink deduplicates starts by call id.
        this.#itemStarted(sink, item);
        const importing = (async () => {
          try {
            if (turn.readOnly)
              throw new Error(
                "Cannot import generated images during a planning turn",
              );
            if (item.status !== "completed" || item.failure)
              throw new Error(
                `Codex image generation failed (${String(item.status)})`,
              );
            const result = await importCodexImage(
              item,
              this.#threadId!,
              this.context,
            );
            if (this.#turn === turn && !turn.signal.aborted)
              sink.toolResult(id, result, false);
          } catch (cause) {
            if (this.#turn !== turn || turn.signal.aborted) return;
            turn.imageError = `Codex image could not be delivered: ${cause instanceof Error ? cause.message : String(cause)}`;
            sink.toolResult(id, textResult(turn.imageError), true);
          }
        })();
        turn.images.set(id, importing);
        return;
      }
      case "agentMessage":
        sink.textDone(
          id,
          typeof item.text === "string" ? item.text : undefined,
        );
        return;
      case "reasoning": {
        const summary = Array.isArray(item.summary)
          ? item.summary.filter((part) => typeof part === "string").join("\n\n")
          : "";
        sink.thinkingDone(id, summary || undefined);
        return;
      }
      case "commandExecution":
        sink.toolResult(
          id,
          textResult(
            typeof item.aggregatedOutput === "string"
              ? item.aggregatedOutput
              : "",
          ),
          item.status === "failed" ||
            (typeof item.exitCode === "number" && item.exitCode !== 0) ||
            item.status === "declined",
        );
        return;
      case "fileChange": {
        const changes = Array.isArray(item.changes)
          ? (item.changes as Array<Record<string, unknown>>)
          : [];
        sink.toolResult(
          id,
          textResult(
            changes
              .map(
                (change) =>
                  `${changeKind(change.kind)} ${String(change.path ?? "")}`,
              )
              .join("\n"),
          ),
          item.status === "failed" || item.status === "declined",
        );
        return;
      }
      case "dynamicToolCall": {
        const stored = this.#bridged.take(id);
        sink.toolResult(
          id,
          stored?.result ?? dynamicResult(item.contentItems),
          stored ? stored.isError : item.success === false,
        );
        return;
      }
      case "mcpToolCall": {
        const result = record(item.result);
        sink.toolResult(
          id,
          item.error
            ? textResult(String(record(item.error)?.message ?? item.error))
            : textResult(result?.content),
          Boolean(item.error) || item.status === "failed",
        );
        return;
      }
      case "webSearch":
        sink.toolResult(
          id,
          textResult(
            Array.isArray(item.results)
              ? JSON.stringify(item.results).slice(0, 4_000)
              : "",
          ),
          false,
        );
        return;
      case "contextCompaction":
        sink.compaction("end", {});
        return;
      default:
        return;
    }
  }

  #bridgeToolName(tool: unknown): string {
    const name = String(tool ?? "");
    // Existing native threads may still call the original unprefixed names.
    return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const turn = this.#turn;
    if (method === "item/tool/call") {
      if (!turn || turn.signal.aborted) throw new Error("No turn is running");
      const callId = String(params.callId ?? "");
      const outcome = await this.context.bridge.call(
        this.#bridgeToolName(params.tool),
        params.arguments,
        callId,
        turn?.signal,
      );
      this.#bridged.record(callId, outcome);
      return {
        contentItems: outcome.result.content.map((part) =>
          part.type === "text"
            ? { type: "inputText", text: part.text }
            : {
                type: "inputImage",
                imageUrl: `data:${part.mimeType};base64,${part.data}`,
              },
        ),
        success: !outcome.isError,
      };
    }
    if (!turn || turn.signal.aborted || this.#turn !== turn)
      return refusal(method);
    const approval = codexApproval(method, params);
    if (approval) {
      // Planning never stops to ask: what Codex would ask about is not reading.
      if (turn.readOnly) return refusal(method, PLANNING_DENIAL);
      const decision = await turn.sink.requestApproval(approval, {
        ...(typeof params.itemId === "string" ? { callId: params.itemId } : {}),
        signal: turn.signal,
      });
      if (turn.signal.aborted || this.#turn !== turn) return refusal(method);
      return codexAnswer(method, params, decision);
    }
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "mcpServer/elicitation/request")
      return { action: "decline" };
    throw new Error(`Unsupported request ${method}`);
  }
}

function codexInput(input: NativeTurnInput): Array<Record<string, unknown>> {
  return [
    { type: "text", text: input.text, text_elements: [] },
    ...input.images.map((image) => ({
      type: "image",
      url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];
}

/** The command as the person would type it, without the login shell Codex wraps it in. */
function commandText(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map(String).join(" ")
    : typeof value === "string"
      ? value
      : "";
  const wrapped = text.match(/^\S*\/(?:ba|z)?sh -l?c (["'])([\s\S]*)\1$/);
  return wrapped ? wrapped[2]! : text;
}

function changeKind(kind: unknown): string {
  const type = record(kind)?.type;
  return type === "add" ? "Added" : type === "delete" ? "Deleted" : "Updated";
}

function dynamicResult(items: unknown): NativeToolResult {
  if (!Array.isArray(items)) return { content: [] };
  return {
    content: items.flatMap((item): NativeToolResult["content"] => {
      const value = record(item);
      if (value?.type === "inputText" && typeof value.text === "string")
        return [{ type: "text", text: value.text }];
      return [];
    }),
  };
}

function codexError(message: unknown): string {
  if (typeof message !== "string") return "";
  // Codex passes the model service's error body through as JSON text.
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    /* plain text */
  }
  return message;
}

const READ_PROFILE = ":read-only";

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "execCommandApproval",
  "item/fileChange/requestApproval",
  "applyPatchApproval",
  "item/permissions/requestApproval",
]);

/** Keeps the person's Codex configuration, without a recursive connection to OhMyGame. */
async function codexConfig(
  server: CodexAppServer,
  workspacePath: string,
): Promise<Record<string, unknown>> {
  try {
    const read = await server.request<{ config?: Record<string, unknown> }>(
      "config/read",
      { cwd: workspacePath },
    );
    // Avoid recursively reconnecting to OhMyGame through the person's own MCP config.
    return record(record(read.config?.mcp_servers)?.[EXTERNAL_MCP_SERVER_NAME])
      ? { [`mcp_servers.${EXTERNAL_MCP_SERVER_NAME}.enabled`]: false }
      : {};
  } catch {
    return {};
  }
}

/** What Codex asks to be allowed, for the approval card; undefined for other requests. */
export function codexApproval(
  method: string,
  params: Record<string, unknown>,
): ApprovalRequestDetails | undefined {
  if (!APPROVAL_METHODS.has(method)) return undefined;
  const reason =
    typeof params.reason === "string" && params.reason
      ? { reason: params.reason }
      : {};
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    const amendment = Array.isArray(params.proposedExecpolicyAmendment)
      ? params.proposedExecpolicyAmendment.map(String)
      : [];
    return {
      kind: "command",
      tool: "shell",
      command: commandText(params.command),
      ...reason,
      ...(record(params.networkApprovalContext) ? { network: true } : {}),
      always: amendment.length
        ? { scope: "saved", rules: [amendment.join(" ")] }
        : { scope: "session", rules: [] },
    };
  }
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  ) {
    const root =
      typeof params.grantRoot === "string" ? params.grantRoot : undefined;
    const files = Object.keys(record(params.fileChanges) ?? {});
    return {
      kind: "file",
      tool: "apply_patch",
      ...(root ? { path: root } : {}),
      ...(!root && files.length
        ? {
            paths: files.map((file) => ({
              path: file,
              access: "write" as const,
            })),
          }
        : {}),
      ...reason,
      always: { scope: "session", rules: root ? [root] : [] },
    };
  }
  const permissions = record(params.permissions);
  const files = record(permissions?.fileSystem);
  const paths: NonNullable<ApprovalRequestDetails["paths"]> = [];
  for (const access of ["read", "write"] as const)
    for (const value of Array.isArray(files?.[access]) ? files[access] : [])
      if (typeof value === "string") paths.push({ path: value, access });
  for (const value of Array.isArray(files?.entries) ? files.entries : []) {
    const entry = record(value);
    const location = record(entry?.path);
    if (
      typeof location?.path === "string" &&
      (entry?.access === "read" || entry?.access === "write")
    )
      paths.push({ path: location.path, access: entry.access });
  }
  return {
    kind: "other",
    tool: "permissions",
    ...reason,
    ...(paths.length
      ? {
          paths: [
            ...new Map(
              paths.map((entry) => [`${entry.access}:${entry.path}`, entry]),
            ).values(),
          ],
        }
      : {}),
    ...(record(permissions?.network)?.enabled === true
      ? { network: true }
      : {}),
    always: { scope: "session", rules: [] },
  };
}

/** The person's answer in the form each Codex request expects. */
export function codexAnswer(
  method: string,
  params: Record<string, unknown>,
  decision: ApprovalDecision,
): unknown {
  if (decision === "deny") return refusal(method);
  const always = decision === "allow-always";
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const amendment = params.proposedExecpolicyAmendment;
      return {
        decision: !always
          ? "accept"
          : Array.isArray(amendment) && amendment.length
            ? {
                acceptWithExecpolicyAmendment: {
                  execpolicy_amendment: amendment,
                },
              }
            : "acceptForSession",
      };
    }
    case "execCommandApproval": {
      const amendment = params.proposedExecpolicyAmendment;
      return {
        decision: !always
          ? "approved"
          : Array.isArray(amendment) && amendment.length
            ? {
                approved_execpolicy_amendment: {
                  proposed_execpolicy_amendment: amendment,
                },
              }
            : "approved_for_session",
      };
    }
    case "item/fileChange/requestApproval":
      return { decision: always ? "acceptForSession" : "accept" };
    case "applyPatchApproval":
      return { decision: always ? "approved_for_session" : "approved" };
    default:
      // A permission grant is what Codex asked for, for this turn or its session.
      return {
        permissions: record(params.permissions) ?? {},
        scope: always ? "session" : "turn",
      };
  }
}

/** Declines a request in the form Codex expects for it. */
function refusal(
  method: string,
  reason = "The person denied this request.",
): unknown {
  switch (method) {
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: { denied: { rejection: reason } } };
    default:
      return { decision: "decline" };
  }
}
