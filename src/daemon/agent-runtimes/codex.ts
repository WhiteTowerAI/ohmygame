import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { ApprovalRequestDetails } from "../../shared/agent-runtimes.js";
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
  CODEX_APPROVAL_POLICY,
  requireCodexPermissionProfile,
} from "./codex-app-server.js";
import {
  BridgeResults,
  number,
  record,
  textResult,
  type DriverContext,
} from "./driver-context.js";
import {
  acquireCodexServer,
  type CodexServerLease,
} from "./codex-server-pool.js";
import { NativeSessionExpiredError } from "./native-session.js";
import { canonicalPath, judgeApproval } from "./policy.js";
import { sandboxedPath, sessionCaches, toolchainRoots } from "./environment.js";
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
 * same pipe; commands run in Codex's own workspace sandbox, and what it asks
 * to do beyond it comes back as an approval request.
 */
export class CodexDriver implements NativeDriver {
  #disposed = false;
  readonly #profile = `ohmygame-${randomUUID()}`;
  readonly #readProfile = `${this.#profile}-read`;
  /** Full access is Codex's own unsandboxed profile; planning keeps the read-only one. */
  readonly #writeProfile: string;
  #limits: NonNullable<AgentContextUsage["limits"]> = [];
  #lease?: CodexServerLease;
  #starting?: Promise<CodexAppServer>;
  #threadId?: string;
  #turn?: CodexTurn;
  #bridged = new BridgeResults();

  constructor(private readonly context: DriverContext) {
    this.#threadId = context.resume;
    this.#writeProfile = context.policy.fullAccess
      ? ":danger-full-access"
      : this.#profile;
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
            key: shared?.key ?? `private-${this.#profile}`,
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
      // Never approve unrestricted sandbox escapes. Scoped permission requests
      // can still be reviewed without removing the protected-read boundary.
      approvalPolicy: CODEX_APPROVAL_POLICY,
      permissions: this.#writeProfile,
      model: this.context.model,
      developerInstructions: this.context.instructions,
      config: await this.#config(server),
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

  /** Overrides that keep the person's own Codex MCP servers and notification hook out of OhMyGame's runs. */
  async #config(server: CodexAppServer): Promise<Record<string, unknown>> {
    // An explicit root deny prevents even scoped grants. Unlisted paths are
    // restricted by default; only protected roots get an explicit deny.
    const filesystem: Record<string, unknown> = { ":minimal": "read" };
    const temporary = path.join(this.context.privateDirectory, "tmp");
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    filesystem[canonicalPath(temporary)] = "write";
    const workspace = canonicalPath(this.context.workspacePath);
    // The person's toolchains run, as for OhMyGame's own agent; protected roots below stay denied.
    for (const root of toolchainRoots(this.context.env.PATH ?? ""))
      filesystem[canonicalPath(root)] ??= "read";
    // Private staged Skills remain readable; the rest of app data stays denied.
    if (this.#lease?.skillsRoot)
      filesystem[canonicalPath(this.#lease.skillsRoot)] = "read";
    for (const protectedPath of this.context.policy.neverTouch) {
      const target = canonicalPath(protectedPath);
      // The app may own the workspace's parent; its narrower workspace grant wins.
      if (target !== workspace) filesystem[target] = "deny";
    }
    // Codex's minimal access reads the shared temporary folders, where other
    // programs and people leave files; commands get their own temporary
    // folder instead. A workspace inside one keeps its narrower grant.
    if (process.platform !== "win32")
      for (const shared of ["/tmp", "/var/tmp"])
        filesystem[canonicalPath(shared)] ??= "deny";
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
      // A login shell would rebuild PATH with macOS's path_helper and read
      // startup files the profile denies; the PATH given here already holds
      // the login shell's folders.
      allow_login_shell: false,
      // Only the workspace's own AGENTS.md counts, as for OhMyGame's own agent:
      // a parent folder's instructions describe whatever happens to contain
      // the game, and its files are outside the permission profile.
      project_root_markers: [],
      permissions: {
        [this.#profile]: profile(false),
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
        PATH: sandboxedPath(this.context.env.PATH ?? ""),
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
        ...sessionCaches(temporary),
        // ~/.gitconfig may hold credential helpers; commands get only the person's identity.
        GIT_CONFIG_GLOBAL: await privateGitConfig(temporary, this.context.env),
      },
    };
    let servers: Record<string, unknown>;
    try {
      const read = await server.request<{ config?: Record<string, unknown> }>(
        "config/read",
        { cwd: this.context.workspacePath },
      );
      servers = record(read.config?.mcp_servers) ?? {};
    } catch {
      if (!this.context.isolateUserConfig) return config;
      throw new Error(
        "Codex configuration could not be checked. Retry, or explicitly enable your own CLI configuration in Settings.",
      );
    }
    if (!this.context.isolateUserConfig) {
      // The person's own configuration may connect Codex to OhMyGame from outside.
      if (servers[EXTERNAL_MCP_SERVER_NAME])
        config[`mcp_servers.${EXTERNAL_MCP_SERVER_NAME}.enabled`] = false;
      return config;
    }
    config.notify = [];
    for (const name of Object.keys(servers))
      config[`mcp_servers.${name}.enabled`] = false;
    // Codex has no way to leave out the person's Skills, plugins and AGENTS.md from its own folder.
    return config;
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

/**
 * A Git configuration for sandboxed commands with the person's name and email
 * and nothing else from ~/.gitconfig, which may name credential helpers and
 * is outside the permission profile.
 */
async function privateGitConfig(
  directory: string,
  env: Record<string, string>,
): Promise<string> {
  const file = path.join(directory, "gitconfig");
  const identity: string[] = [];
  for (const key of ["user.name", "user.email"]) {
    const value = await new Promise<string>((resolve) =>
      execFile(
        "git",
        ["config", "--global", "--get", key],
        { env, timeout: 3_000, encoding: "utf8" },
        (error, stdout) => resolve(error ? "" : stdout.trim()),
      ),
    );
    if (value && !/[\r\n"\\]/.test(value))
      identity.push(`\t${key.slice(5)} = "${value}"`);
  }
  await writeFile(
    file,
    identity.length ? `[user]\n${identity.join("\n")}\n` : "",
    { mode: 0o600 },
  );
  return file;
}
