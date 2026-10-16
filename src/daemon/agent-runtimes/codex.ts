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
import {
  decideApproval,
  textResult,
  type DriverContext,
} from "./driver-context.js";
import { stageSkills } from "./skills.js";

const REQUEST_TIMEOUT_MS = 60_000;
export const CODEX_CLIENT = {
  name: "ohmygame",
  title: "OhMyGame",
  version: "1",
};

/** A JSON-RPC connection to `codex app-server` over its stdio, one message per line each way. */
export class CodexAppServer {
  readonly process: AgentProcess;
  #next = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (cause: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #closed?: Error;

  constructor(
    binaryPath: string,
    cwd: string,
    env: Record<string, string>,
    private readonly handlers: {
      notification?: (method: string, params: Record<string, unknown>) => void;
      request?: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
      exit?: (failure: string) => void;
    } = {},
  ) {
    this.process = new AgentProcess({
      binaryPath,
      args: ["app-server"],
      cwd,
      env,
      onLine: (line) => this.#receive(line),
      onExit: (code, signal, stderr) => {
        this.#closed = new Error(processFailure("Codex", code, signal, stderr));
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(this.#closed);
        }
        this.#pending.clear();
        handlers.exit?.(this.#closed.message);
      },
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: CODEX_CLIENT,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex did not answer ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.process.write({ jsonrpc: "2.0", id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.process.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  stop(): Promise<void> {
    return this.process.stop();
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      const params = record(message.params) ?? {};
      if (id === undefined || id === null) {
        this.handlers.notification?.(message.method, params);
        return;
      }
      void (
        this.handlers.request?.(message.method, params) ??
        Promise.reject(new Error(`Unsupported request ${message.method}`))
      ).then(
        (result) => {
          if (this.process.running)
            this.process.write({ jsonrpc: "2.0", id, result });
        },
        (cause) => {
          if (this.process.running)
            this.process.write({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: cause instanceof Error ? cause.message : String(cause),
              },
            });
        },
      );
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = record(message.error);
    if (error)
      pending.reject(
        new Error(String(error.message ?? "Codex request failed")),
      );
    else pending.resolve(message.result);
  }
}

interface CodexTurn {
  sink: NativeTurnSink;
  signal: AbortSignal;
  resolve: (outcome: NativeTurnOutcome) => void;
  turnId?: string;
  error?: string;
}

/**
 * Codex through its app server: one thread per conversation, one turn per
 * message. OhMyGame's tools are the thread's dynamic tools, answered over the
 * same pipe; commands run in Codex's own workspace sandbox, and what it asks
 * to do beyond it comes back as an approval request.
 */
export class CodexDriver implements NativeDriver {
  #server?: CodexAppServer;
  #starting?: Promise<CodexAppServer>;
  #threadId?: string;
  #turn?: CodexTurn;
  #bridged = new Map<string, { result: NativeToolResult; isError: boolean }>();

  constructor(private readonly context: DriverContext) {
    this.#threadId = context.resume;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    let server: CodexAppServer;
    let threadId: string;
    try {
      server = await this.#start();
      threadId = await this.#thread(server, sink);
    } catch (cause) {
      return {
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = { sink, signal, resolve };
      this.#turn = turn;
      server
        .request<{ turn?: { id?: string } }>("turn/start", {
          threadId,
          input: codexInput(input),
          ...(this.context.reasoningLevel &&
          this.context.reasoningLevel !== "off"
            ? { effort: this.context.reasoningLevel }
            : {}),
          model: this.context.model,
          sandboxPolicy: input.readOnly
            ? { type: "readOnly", networkAccess: true }
            : { type: "workspaceWrite", networkAccess: true },
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

  async steer(input: NativeTurnInput): Promise<boolean> {
    const turn = this.#turn;
    if (!turn?.turnId || !this.#server || !this.#threadId) return false;
    try {
      await this.#server.request("turn/steer", {
        threadId: this.#threadId,
        expectedTurnId: turn.turnId,
        input: codexInput(input),
      });
      return true;
    } catch {
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn?.turnId || !this.#server || !this.#threadId) return;
    await this.#server
      .request("turn/interrupt", {
        threadId: this.#threadId,
        turnId: turn.turnId,
      })
      .catch(() => {});
  }

  async compact(sink: NativeTurnSink, signal: AbortSignal): Promise<void> {
    const server = await this.#start();
    const threadId = await this.#thread(server, sink);
    sink.compaction("start");
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = { sink, signal, resolve };
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

  reset(): void {
    this.#threadId = undefined;
  }

  dispose(): void {
    const turn = this.#turn;
    this.#turn = undefined;
    turn?.resolve({ status: "aborted" });
    void this.#server?.stop();
    this.#server = undefined;
  }

  async #start(): Promise<CodexAppServer> {
    if (this.#server?.process.running) return this.#server;
    return (this.#starting ??= (async () => {
      try {
        const server = new CodexAppServer(
          this.context.binaryPath,
          this.context.workspacePath,
          this.context.env,
          {
            notification: (method, params) =>
              this.#notification(method, params),
            request: (method, params) => this.#request(method, params),
            exit: (failure) => {
              if (this.#server === server) this.#server = undefined;
              const turn = this.#turn;
              this.#turn = undefined;
              turn?.resolve(
                turn.signal.aborted
                  ? { status: "aborted" }
                  : { status: "failed", error: failure },
              );
            },
          },
        );
        this.#server = server;
        await server.initialize();
        if (this.context.skillDirectories.length) {
          const root = path.join(this.context.privateDirectory, "codex-skills");
          if ((await stageSkills(this.context.skillDirectories, root)).length) {
            await server
              .request("skills/extraRoots/set", { extraRoots: [root] })
              .catch(() => {});
          }
        }
        return server;
      } finally {
        this.#starting = undefined;
      }
    })());
  }

  async #thread(server: CodexAppServer, sink: NativeTurnSink): Promise<string> {
    const settings = {
      cwd: this.context.workspacePath,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      model: this.context.model,
      developerInstructions: this.context.instructions,
      config: await this.#config(server),
    };
    const tools = this.context.bridge
      .list()
      .map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    if (this.#threadId) {
      try {
        const resumed = await server.request<{ thread?: { id?: string } }>(
          "thread/resume",
          { threadId: this.#threadId, ...settings },
        );
        const id = resumed.thread?.id ?? this.#threadId;
        this.#threadId = id;
        sink.nativeSession(id);
        return id;
      } catch {
        // A thread Codex no longer has: start again; the conversation's record is still OhMyGame's.
        this.#threadId = undefined;
      }
    }
    const started = await server.request<{ thread?: { id?: string } }>(
      "thread/start",
      { ...settings, dynamicTools: tools },
    );
    const id = started.thread?.id;
    if (!id) throw new Error("Codex did not start a thread");
    this.#threadId = id;
    sink.nativeSession(id);
    return id;
  }

  /** Overrides that keep the person's own Codex MCP servers and notification hook out of OhMyGame's runs. */
  async #config(server: CodexAppServer): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = {
      "sandbox_workspace_write.network_access": true,
    };
    if (!this.context.isolateUserConfig) return config;
    config.notify = [];
    try {
      const read = await server.request<{ config?: Record<string, unknown> }>(
        "config/read",
        { cwd: this.context.workspacePath },
      );
      const servers = record(read.config?.mcp_servers) ?? {};
      for (const name of Object.keys(servers))
        config[`mcp_servers.${name}.enabled`] = false;
    } catch {
      // Without the list, the person's servers start as they would in their own terminal.
    }
    // Codex has no way to leave out the person's Skills, plugins and AGENTS.md from its own folder.
    return config;
  }

  #notification(method: string, params: Record<string, unknown>): void {
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
        const usage = record(params.tokenUsage);
        const last = record(usage?.last);
        const total = record(usage?.total);
        if (total) {
          sink.usage(
            {
              input:
                number(total.inputTokens) - number(total.cachedInputTokens),
              output: number(total.outputTokens),
              cacheRead: number(total.cachedInputTokens),
              cacheWrite: number(total.cacheWriteInputTokens),
            },
            typeof usage?.modelContextWindow === "number"
              ? usage.modelContextWindow
              : undefined,
            last
              ? number(last.inputTokens) + number(last.outputTokens)
              : undefined,
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
        const completed = record(params.turn);
        this.#turn = undefined;
        const status = completed?.status;
        if (status === "interrupted" || turn.signal.aborted)
          turn.resolve({ status: "aborted" });
        else if (status === "failed")
          turn.resolve({
            status: "failed",
            error:
              codexError(record(completed?.error)?.message) ||
              turn.error ||
              "Codex could not finish the turn",
          });
        else turn.resolve({ status: "completed" });
        return;
      }
      default:
        return;
    }
  }

  #itemStarted(sink: NativeTurnSink, item: Record<string, unknown>): void {
    const id = typeof item.id === "string" ? item.id : undefined;
    if (!id) return;
    switch (item.type) {
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
          String(item.tool ?? "tool"),
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
        const stored = this.#bridged.get(id);
        this.#bridged.delete(id);
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

  async #request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const turn = this.#turn;
    if (method === "item/tool/call") {
      const callId = String(params.callId ?? "");
      const outcome = await this.context.bridge.call(
        String(params.tool ?? ""),
        params.arguments,
        callId,
        turn?.signal,
      );
      this.#bridged.set(callId, outcome);
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
    if (!turn)
      return method === "item/tool/requestUserInput"
        ? { answers: {} }
        : { decision: "decline" };
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "execCommandApproval"
    ) {
      const details: ApprovalRequestDetails = {
        kind: "command",
        tool: "shell",
        command: commandText(params.command),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        canAllowSession: true,
      };
      return {
        decision: codexDecision(
          await decideApproval(details, this.context, turn.sink, {
            ...(typeof params.itemId === "string"
              ? { callId: params.itemId }
              : {}),
            signal: turn.signal,
            escalation: true,
          }),
        ),
      };
    }
    if (
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval"
    ) {
      const details: ApprovalRequestDetails = {
        kind: "file",
        tool: "apply_patch",
        ...(typeof params.grantRoot === "string"
          ? { path: params.grantRoot }
          : {}),
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        canAllowSession: true,
      };
      const decision = await decideApproval(details, this.context, turn.sink, {
        ...(typeof params.itemId === "string" ? { callId: params.itemId } : {}),
        signal: turn.signal,
        escalation: true,
      });
      return { decision: codexDecision(decision) };
    }
    if (method === "item/permissions/requestApproval") {
      const details: ApprovalRequestDetails = {
        kind: "other",
        tool: "permissions",
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        canAllowSession: false,
      };
      const decision = await turn.sink.requestApproval(details, {
        signal: turn.signal,
      });
      return decision === "deny"
        ? { permissions: {}, scope: "turn" }
        : { permissions: record(params.permissions) ?? {}, scope: "turn" };
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

function codexDecision(decision: ApprovalDecision): string {
  return decision === "allow"
    ? "accept"
    : decision === "allow-session"
      ? "acceptForSession"
      : "decline";
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
