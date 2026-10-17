import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { ApprovalRequestDetails } from "../../shared/agent-runtimes.js";
import type {
  NativeDriver,
  NativeToolResult,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
} from "./native-session.js";
import { AgentProcess, processFailure } from "./process.js";
import { textResult, type DriverContext } from "./driver-context.js";
import { stageSkills } from "./skills.js";
import { NativeSessionExpiredError } from "./native-session.js";
import { canonicalPath, judgeApproval } from "./policy.js";
import type { AgentContextUsage } from "../../shared/contracts.js";

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
      processDirectory?: string;
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
      processDirectory: handlers.processDirectory,
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
  readOnly?: boolean;
}

/**
 * Codex through its app server: one thread per conversation, one turn per
 * message. OhMyGame's tools are the thread's dynamic tools, answered over the
 * same pipe; commands run in Codex's own workspace sandbox, and what it asks
 * to do beyond it comes back as an approval request.
 */
export class CodexDriver implements NativeDriver {
  #disposed = false;
  readonly #writeProfile = `ohmygame-${randomUUID()}`;
  readonly #readProfile = `${this.#writeProfile}-read`;
  #limits: NonNullable<AgentContextUsage["limits"]> = [];
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
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: CodexTurn = {
        sink,
        signal,
        resolve,
        readOnly: input.readOnly,
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
          permissions: input.readOnly ? this.#readProfile : this.#writeProfile,
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

  async dispose(): Promise<void> {
    this.#disposed = true;
    const turn = this.#turn;
    this.#turn = undefined;
    await this.#server?.stop();
    turn?.resolve({ status: "aborted" });
    this.#server = undefined;
  }

  async #start(): Promise<CodexAppServer> {
    if (this.#disposed) throw new Error("The agent session was closed");
    if (this.#server?.process.running) return this.#server;
    return (this.#starting ??= (async () => {
      try {
        const server = new CodexAppServer(
          this.context.binaryPath,
          this.context.workspacePath,
          this.context.env,
          {
            processDirectory: this.context.processDirectory,
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
        if (this.#disposed) throw new Error("The agent session was closed");
        await server
          .request("account/rateLimits/read", {}, 5_000)
          .then((value) => this.#readLimits(value))
          .catch(() => {});
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
      // Never approve unrestricted sandbox escapes. Scoped permission requests
      // can still be reviewed without removing the protected-read boundary.
      approvalPolicy: {
        granular: {
          sandbox_approval: false,
          rules: false,
          mcp_elicitations: false,
          request_permissions: true,
          skill_approval: false,
        },
      },
      permissions: this.#writeProfile,
      model: this.context.model,
      developerInstructions: this.context.instructions,
      config: await this.#config(server),
    };
    const tools = this.context.bridge.list().map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    if (this.#threadId) {
      try {
        const resumed = await server.request<{
          thread?: { id?: string };
          activePermissionProfile?: { id?: string };
        }>("thread/resume", { threadId: this.#threadId, ...settings });
        this.#requireProfile(resumed);
        const id = resumed.thread?.id ?? this.#threadId;
        this.#threadId = id;
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
    const started = await server.request<{
      thread?: { id?: string };
      activePermissionProfile?: { id?: string };
    }>("thread/start", { ...settings, dynamicTools: tools });
    this.#requireProfile(started);
    const id = started.thread?.id;
    if (!id) throw new Error("Codex did not start a thread");
    this.#threadId = id;
    sink.nativeSession(id);
    return id;
  }

  #requireProfile(response: {
    activePermissionProfile?: { id?: string };
  }): void {
    if (response.activePermissionProfile?.id !== this.#writeProfile)
      throw new Error(
        "Codex did not activate OhMyGame's filesystem permissions. Update Codex to a version supporting named permission profiles, then check again in Settings.",
      );
  }

  /** Overrides that keep the person's own Codex MCP servers and notification hook out of OhMyGame's runs. */
  async #config(server: CodexAppServer): Promise<Record<string, unknown>> {
    // An explicit root deny prevents even scoped grants. Unlisted paths are
    // restricted by default; only protected roots get an explicit deny.
    const filesystem: Record<string, unknown> = { ":minimal": "read" };
    const temporary = path.join(this.context.privateDirectory, "tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    filesystem[canonicalPath(temporary)] = "write";
    const workspace = canonicalPath(this.context.workspacePath);
    // Private staged Skills remain readable; the rest of app data stays denied.
    if (this.context.skillDirectories.length)
      filesystem[
        canonicalPath(path.join(this.context.privateDirectory, "codex-skills"))
      ] = "read";
    for (const protectedPath of this.context.policy.neverTouch) {
      const target = canonicalPath(protectedPath);
      // The app may own the workspace's parent; its narrower workspace grant wins.
      if (target !== workspace) filesystem[target] = "deny";
    }
    const profile = (readOnly: boolean) => ({
      filesystem: {
        ...filesystem,
        ":workspace_roots": {
          ".": readOnly ? "read" : "write",
          ".git": "read",
          ".agents": "read",
          ".codex": "read",
          ".aws": "read",
        },
      },
      network: { enabled: true },
    });
    const config: Record<string, unknown> = {
      default_permissions: this.#writeProfile,
      "features.request_permissions_tool": true,
      "features.shell_snapshot": false,
      permissions: {
        [this.#writeProfile]: profile(false),
        [this.#readProfile]: profile(true),
      },
      // A child must not inherit authentication tokens or proxy secrets from the CLI.
      "shell_environment_policy.inherit": "none",
      "shell_environment_policy.set": {
        ...Object.fromEntries(
          Object.entries(this.context.env).filter(
            ([name]) => name !== "CLAUDE_CODE_OAUTH_TOKEN",
          ),
        ),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      },
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
      throw new Error(
        "Codex configuration could not be checked. Retry, or explicitly enable your own CLI configuration in Settings.",
      );
    }
    // Codex has no way to leave out the person's Skills, plugins and AGENTS.md from its own folder.
    return config;
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (method === "account/rateLimits/updated") {
      this.#readLimits(params);
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

  #readLimits(value: unknown): void {
    const data = record(value);
    const buckets = record(data?.rateLimitsByLimitId) ?? {
      codex: data?.rateLimits,
    };
    const limits: NonNullable<AgentContextUsage["limits"]> = [];
    for (const [bucket, raw] of Object.entries(buckets)) {
      const windows = record(raw);
      for (const window of ["primary", "secondary"]) {
        const item = record(windows?.[window]);
        if (typeof item?.usedPercent !== "number") continue;
        limits.push({
          id: `${bucket}/${window}`,
          usedPercent: Math.max(0, Math.min(100, item.usedPercent)),
          ...(typeof item.windowDurationMins === "number"
            ? { windowMinutes: item.windowDurationMins }
            : {}),
          ...(typeof item.resetsAt === "number"
            ? { resetsAt: item.resetsAt }
            : {}),
        });
      }
    }
    this.#limits = limits;
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
      if (!turn || turn.signal.aborted) throw new Error("No turn is running");
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
    if (!turn || turn.signal.aborted)
      return method === "item/permissions/requestApproval"
        ? { permissions: {}, scope: "turn" }
        : method === "item/tool/requestUserInput"
          ? { answers: {} }
          : { decision: "decline" };
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "execCommandApproval"
    ) {
      return { decision: "decline" };
    }
    if (
      method === "item/fileChange/requestApproval" ||
      method === "applyPatchApproval"
    ) {
      return { decision: "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      const permissions = record(params.permissions);
      const files = record(permissions?.fileSystem);
      let paths: NonNullable<ApprovalRequestDetails["paths"]> = [];
      for (const access of ["read", "write"] as const) {
        const requested = files?.[access];
        if (
          requested != null &&
          (!Array.isArray(requested) ||
            requested.some((value) => typeof value !== "string"))
        )
          return { permissions: {}, scope: "turn" };
        for (const value of (requested ?? []) as string[])
          paths.push({ path: value, access });
      }
      if (files?.entries != null) {
        if (!Array.isArray(files.entries))
          return { permissions: {}, scope: "turn" };
        for (const value of files.entries) {
          const entry = record(value);
          const location = record(entry?.path);
          if (
            location?.type !== "path" ||
            typeof location.path !== "string" ||
            (entry?.access !== "read" && entry?.access !== "write")
          )
            return { permissions: {}, scope: "turn" };
          paths.push({ path: location.path, access: entry.access });
        }
      }
      // New CLIs can send both legacy lists and entries for the same grant.
      paths = [
        ...new Map(
          paths.map((entry) => [
            JSON.stringify([entry.path, entry.access]),
            entry,
          ]),
        ).values(),
      ];
      if (
        !permissions ||
        (turn.readOnly && paths.some((entry) => entry.access === "write")) ||
        paths.length > 100 ||
        paths.some(
          (entry) =>
            !path.isAbsolute(entry.path) ||
            /[*?\[\]{}\0]/.test(entry.path) ||
            judgeApproval(
              {
                kind: "file",
                tool: entry.access === "read" ? "Read" : "Write",
                path: entry.path,
                canAllowSession: false,
              },
              this.context.policy,
            ) === "deny",
        )
      )
        return { permissions: {}, scope: "turn" };
      const details: ApprovalRequestDetails = {
        kind: "other",
        tool: "permissions",
        ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
        canAllowSession: false,
        ...(paths.length ? { paths } : {}),
        ...(record(permissions.network)?.enabled === true
          ? { network: true }
          : {}),
      };
      const decision = await turn.sink.requestApproval(details, {
        signal: turn.signal,
      });
      return decision === "deny"
        ? { permissions: {}, scope: "turn" }
        : {
            permissions: {
              ...(files
                ? {
                    fileSystem: {
                      read: Array.isArray(files.read) ? files.read : null,
                      write: Array.isArray(files.write) ? files.write : null,
                      ...(Array.isArray(files.entries)
                        ? { entries: files.entries }
                        : {}),
                    },
                  }
                : {}),
              ...(details.network ? { network: { enabled: true } } : {}),
            },
            scope: "turn",
          };
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
