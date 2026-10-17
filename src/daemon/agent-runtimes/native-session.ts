import { randomUUID } from "node:crypto";
import type {
  AgentSessionEvent,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentContextUsage } from "../../shared/contracts.js";
import type {
  AgentRuntimeId,
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import { CHECKPOINT_ENTRY, recordCheckpoint } from "../checkpoint-extension.js";
import type { CodingSession, SkillCatalogItem } from "../agent.js";
import { handoffSummary } from "./handoff.js";

/** The custom entry that records which native session a conversation's branch continues. */
export const NATIVE_SESSION_ENTRY = "ohmygame-native-session";

export interface StoredNativeSession {
  version: 2;
  runtime: AgentRuntimeId;
  state: "active" | "ready" | "invalid";
  sessionId?: string;
}

/** A native context was removed; the shared session must rebuild it from the current branch. */
export class NativeSessionExpiredError extends Error {}

export interface PromptImage {
  type: "image";
  mimeType: string;
  data: string;
}

export interface NativeTurnInput {
  text: string;
  images: PromptImage[];
  /** Planning turns may read but not change the workspace. */
  readOnly: boolean;
}

/** A tool result in the shape OhMyGame's own tools return, so artifacts and images show the same way. */
export interface NativeToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
}

export type NativeTurnOutcome =
  | { status: "completed" }
  | { status: "aborted" }
  | { status: "failed"; error: string };

export interface NativeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What a protocol adapter reports while a turn runs. Text and reasoning are
 * keyed by the adapter's own block ids; a tool call is announced with its
 * arguments, then started and finished by its call id.
 */
export interface NativeTurnSink {
  limits?(limits: NonNullable<AgentContextUsage["limits"]>): void;
  text(key: string, delta: string): void;
  textDone(key: string, text?: string): void;
  thinking(key: string, delta: string): void;
  thinkingDone(key: string, text?: string): void;
  toolCall(callId: string, name: string, args: Record<string, unknown>): void;
  toolStarted(callId: string): void;
  toolUpdate(callId: string, result: NativeToolResult): void;
  toolResult(callId: string, result: NativeToolResult, isError: boolean): void;
  usage(
    usage: NativeUsage,
    contextWindow?: number,
    contextTokens?: number,
  ): void;
  compaction(
    phase: "start" | "end",
    result?: {
      summary?: string;
      tokensBefore?: number;
      error?: string;
      aborted?: boolean;
    },
  ): void;
  nativeSession(sessionId: string): void;
  /** Asks the person; `callId` names the tool call the request is about, when the agent says. */
  requestApproval(
    details: ApprovalRequestDetails,
    options?: { callId?: string; signal?: AbortSignal },
  ): Promise<ApprovalDecision>;
}

/** A protocol adapter: Claude Code stream-json, Codex app-server or OpenCode serve. */
export interface NativeDriver {
  /** Runs one user message to the end of the native turn. */
  runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome>;
  interrupt(): Promise<void>;
  compact?(
    sink: NativeTurnSink,
    signal: AbortSignal,
    instructions?: string,
  ): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface NativeSessionOptions {
  runtime: AgentRuntimeId;
  /** The model as the conversation names it: the runtime's own model ID. */
  model: string;
  nativeReasoningLevel?: string;
  sessionManager: SessionManager;
  /** Creates the adapter for the native session the branch continues, if any. */
  createDriver(
    resume: string | undefined,
    settings: { model: string; reasoningLevel?: string },
  ): NativeDriver;
  snapshotBeforeMessage?: () => Promise<string>;
  /** Text that the next message must carry, such as a notice that files were restored. */
  turnNotice?: () => Promise<string | undefined>;
  requestApproval(
    details: ApprovalRequestDetails,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision>;
  /** OhMyGame tools offered to the agent, by the names Pi gives them. */
  toolNames: readonly string[];
  setActiveTools?(names: readonly string[]): void;
  skills?: () => SkillCatalogItem[];
  dispose?(): void | Promise<void>;
  /** Time allowed for a native interrupt before its process is stopped. */
  cancellationTimeoutMs?: number;
}

const NATIVE_API = "ohmygame-native";

/**
 * A conversation run by a coding agent CLI. It keeps the conversation in the
 * same Pi session file as OhMyGame's own agent: every user message, answer
 * and tool result is stored as a Pi message, after the checkpoint taken for
 * it, so the conversation list, Undo, message edits and restarts work the
 * same. The CLI keeps its own context; the stored messages are a record and,
 * when the conversation moves to another agent, the source of a summary.
 */
export class NativeCodingSession implements CodingSession {
  readonly runtime: AgentRuntimeId;
  readonly sessionManager: SessionManager;
  readonly emitsInitialUserMessage = true;
  readonly messages: unknown[] = [];
  #driver: NativeDriver;
  #listeners = new Set<(event: AgentSessionEvent) => void>();
  #followUps: Array<{ text: string; images: PromptImage[] }> = [];
  #steering: Array<{ text: string; images: PromptImage[] }> = [];
  #running?: { controller: AbortController; done: Promise<void> };
  #readOnly = false;
  #handoff: boolean;
  #nativeSessionId?: string;
  #usage?: AgentContextUsage;
  #allowed = new Set<string>();
  #checkpointFailure?: { cause: unknown };
  #disposed = false;

  constructor(private readonly options: NativeSessionOptions) {
    this.runtime = options.runtime;
    this.sessionManager = options.sessionManager;
    this.messages.push(
      ...this.sessionManager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
    const stored = latestNativeSession(
      this.sessionManager.getBranch(),
      options.runtime,
    );
    this.#nativeSessionId = stored?.sessionId;
    // A branch with messages and no native session of this agent was held by another agent, or by this one before
    // an edit or a restore went back past where its session began.
    this.#handoff = !stored && hasMessages(this.sessionManager.getBranch());
    this.#driver = options.createDriver(stored?.sessionId, {
      model: options.model,
      reasoningLevel: options.nativeReasoningLevel,
    });
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(
    prompt: string,
    options?: { images?: PromptImage[] },
  ): Promise<void> {
    if (this.#disposed) throw new Error("The agent session was closed");
    if (this.#running) throw new Error("The agent is already running");
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#running = { controller, done };
    this.#checkpointFailure = undefined;
    try {
      let next: { text: string; images: PromptImage[] } | undefined = {
        text: prompt,
        images: options?.images ?? [],
      };
      while (next && !controller.signal.aborted) {
        const failed = await this.#runMessage(
          next.text,
          next.images,
          controller.signal,
        );
        if (failed) {
          this.#followUps = [];
          this.#steering = [];
          break;
        }
        next = this.#steering.shift() ?? this.#followUps.shift();
      }
    } finally {
      this.#running = undefined;
      settle();
      this.#emit({ type: "agent_settled", aborted: controller.signal.aborted });
    }
    // A failed snapshot stops the run before the agent sees the message, as it does for Pi.
    const failure = this.#checkpointFailure as { cause: unknown } | undefined;
    if (failure) throw failure.cause;
  }

  async followUp(prompt: string, images?: PromptImage[]): Promise<void> {
    this.#followUps.push({ text: prompt, images: images ?? [] });
  }

  async steer(prompt: string, images?: PromptImage[]): Promise<void> {
    // A CLI can write independently of the daemon. Delivering steering while it
    // runs cannot provide a stable pre-message snapshot, so admit it next turn.
    this.#steering.push({ text: prompt, images: images ?? [] });
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const followUp = this.#followUps.map((item) => item.text);
    this.#followUps = [];
    const steering = this.#steering.map((item) => item.text);
    this.#steering = [];
    return { steering, followUp };
  }

  async abort(): Promise<void> {
    this.#followUps = [];
    this.#steering = [];
    const running = this.#running;
    if (!running) return;
    running.controller.abort();
    const timeout = this.options.cancellationTimeoutMs ?? 1_500;
    await bounded(
      this.#driver.interrupt().catch(() => {}),
      timeout,
    );
    if (!(await bounded(running.done, timeout))) {
      await this.#driver.dispose();
      await running.done;
    }
  }

  async compact(customInstructions?: string): Promise<void> {
    if (!this.#driver.compact)
      throw new Error("This agent cannot compact its context");
    if (this.#running)
      throw new Error(
        "Wait for the agent to finish before compacting the session",
      );
    const controller = new AbortController();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.#running = { controller, done };
    const turn = new TurnRecorder(this, this.options.model);
    this.#storeNativeState("active");
    try {
      const sink = turn.sink();
      const report = sink.compaction;
      sink.compaction = (phase, result) =>
        report(phase, {
          ...result,
          ...(controller.signal.aborted ? { aborted: true } : {}),
        });
      await this.#driver.compact(sink, controller.signal, customInstructions);
      if (controller.signal.aborted) await this.#resetContext();
      else this.#storeNativeState("ready");
    } catch (cause) {
      await this.#resetContext();
      throw cause;
    } finally {
      this.#running = undefined;
      settle();
    }
  }

  abortCompaction(): void {
    void this.abort();
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.#usage;
  }

  async navigateTree(
    targetId: string,
  ): Promise<{ editorText?: string; cancelled: boolean }> {
    if (this.#running)
      throw new Error(
        "Wait for the current response to finish before navigating the session tree.",
      );
    const target = this.sessionManager.getEntry(targetId);
    if (!target) throw new Error(`Entry ${targetId} not found`);
    let editorText: string | undefined;
    if (target.type === "message" && target.message.role === "user") {
      editorText = contentText(target.message.content);
      if (target.parentId === null) this.sessionManager.resetLeaf();
      else this.sessionManager.branch(target.parentId);
    } else {
      this.sessionManager.branch(targetId);
    }
    // Even an unchanged native ID may contain turns removed by this rewind.
    await this.#resetContext();
    this.messages.splice(
      0,
      this.messages.length,
      ...this.sessionManager
        .getBranch()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
    return {
      cancelled: false,
      ...(editorText !== undefined ? { editorText } : {}),
    };
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.#readOnly =
      !toolNames.includes("write") &&
      !toolNames.includes("edit") &&
      !toolNames.includes("bash");
    this.options.setActiveTools?.(toolNames);
  }

  getAllTools(): Array<{ name: string }> {
    return [
      ...new Set([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        ...this.options.toolNames,
      ]),
    ].map((name) => ({ name }));
  }

  getSkills(): SkillCatalogItem[] {
    return this.options.skills?.() ?? [];
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#running?.controller.abort();
    // Keep generated config/Skills until the process has actually stopped.
    void Promise.resolve(this.#driver.dispose())
      .finally(() => this.options.dispose?.())
      .catch(() => {});
    this.#listeners.clear();
  }

  /** Records the usage the agent reported for its context. */
  reportUsage(
    tokens: number | undefined,
    contextWindow: number | undefined,
  ): void {
    if (!contextWindow) return;
    this.#usage = {
      ...this.#usage,
      tokens: tokens ?? null,
      contextWindow,
      percent:
        tokens === undefined
          ? null
          : Math.min(100, (tokens / contextWindow) * 100),
    };
  }

  reportLimits(limits: NonNullable<AgentContextUsage["limits"]>): void {
    this.#usage = {
      tokens: null,
      contextWindow: 0,
      percent: null,
      ...this.#usage,
      limits,
    };
  }

  recordNativeSession(sessionId: string): void {
    if (sessionId === this.#nativeSessionId) return;
    this.#nativeSessionId = sessionId;
    this.sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      runtime: this.runtime,
      state: "active",
      sessionId,
    } satisfies StoredNativeSession);
  }

  async approve(
    details: ApprovalRequestDetails,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    if (signal?.aborted || this.#disposed) return "deny";
    const key = approvalKey(details);
    if (this.#allowed.has(key)) return "allow";
    const decision = await this.options.requestApproval(
      details,
      toolCallId,
      signal,
    );
    if (decision === "allow-session" && details.canAllowSession)
      this.#allowed.add(key);
    return decision;
  }

  emit(event: AgentSessionEvent): void {
    this.#emit(event);
  }

  storeMessage(message: Record<string, unknown>): void {
    this.sessionManager.appendMessage(
      message as Parameters<SessionManager["appendMessage"]>[0],
    );
    this.messages.push(message);
  }

  async #runMessage(
    text: string,
    images: PromptImage[],
    signal: AbortSignal,
  ): Promise<boolean> {
    const history = this.sessionManager.getBranch();
    if (!(await this.#storeUserMessage(text, images))) return true;
    if (signal.aborted) return true;
    const notice = await this.options.turnNotice?.().catch(() => undefined);
    let wire = notice
      ? `${text}\n\nWorkspace restore notice (inspect current files before continuing):\n${notice}`
      : text;
    const currentPrompt = wire;
    if (this.#handoff) {
      const summary = handoffSummary(history);
      if (summary) wire = `${summary}\n\n${wire}`;
      this.#handoff = false;
    }
    // A crash or interrupted write must never leave an earlier ready marker
    // claiming that this native context still matches the branch.
    this.#storeNativeState("active");
    const turn = new TurnRecorder(this, this.options.model);
    let outcome: NativeTurnOutcome;
    try {
      try {
        outcome = await this.#driver.runTurn(
          { text: wire, images, readOnly: this.#readOnly },
          turn.sink(),
          signal,
        );
      } catch (cause) {
        if (!(cause instanceof NativeSessionExpiredError) || signal.aborted)
          throw cause;
        await this.#resetContext();
        const summary = handoffSummary(history);
        outcome = await this.#driver.runTurn(
          {
            text: summary ? `${summary}\n\n${currentPrompt}` : currentPrompt,
            images,
            readOnly: this.#readOnly,
          },
          turn.sink(),
          signal,
        );
        this.#handoff = false;
      }
    } catch (cause) {
      outcome = signal.aborted
        ? { status: "aborted" }
        : {
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          };
    }
    if (signal.aborted && outcome.status !== "failed")
      outcome = { status: "aborted" };
    turn.finish(outcome);
    if (outcome.status === "completed") this.#storeNativeState("ready");
    else await this.#resetContext();
    return outcome.status !== "completed";
  }

  #storeNativeState(state: StoredNativeSession["state"]): void {
    this.sessionManager.appendCustomEntry(NATIVE_SESSION_ENTRY, {
      version: 2,
      runtime: this.runtime,
      state,
      ...(state !== "invalid" && this.#nativeSessionId
        ? { sessionId: this.#nativeSessionId }
        : {}),
    } satisfies StoredNativeSession);
  }

  async #resetContext(): Promise<void> {
    this.#storeNativeState("invalid");
    this.#nativeSessionId = undefined;
    await this.#driver.dispose();
    this.#driver = this.options.createDriver(undefined, {
      model: this.options.model,
      reasoningLevel: this.options.nativeReasoningLevel,
    });
    this.#handoff = hasMessages(this.sessionManager.getBranch());
    this.#usage = undefined;
    this.#allowed.clear();
  }

  /** Stores a user message after the checkpoint taken for it, as Pi does. False when the snapshot failed. */
  async #storeUserMessage(
    text: string,
    images: PromptImage[],
  ): Promise<boolean> {
    const message = {
      role: "user" as const,
      content: images.length
        ? [{ type: "text" as const, text }, ...images]
        : text,
      timestamp: Date.now(),
    };
    this.#emit({ type: "message_start", message } as AgentSessionEvent);
    const snapshot = this.options.snapshotBeforeMessage;
    if (snapshot) {
      try {
        await recordCheckpoint(
          (data) =>
            this.sessionManager.appendCustomEntry(CHECKPOINT_ENTRY, data),
          snapshot,
        );
      } catch (cause) {
        this.#checkpointFailure ??= { cause };
        return false;
      }
    }
    // As in Pi, the message ends before it is stored: OhMyGame finds the message's checkpoint among the entries before it.
    this.#emit({ type: "message_end", message } as AgentSessionEvent);
    this.storeMessage(message);
    return true;
  }

  #emit(event: AgentSessionEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        /* A listener's failure is its own. */
      }
    }
  }
}

interface ToolState {
  name: string;
  args: Record<string, unknown>;
  started: boolean;
  finished: boolean;
}

/**
 * Turns what an adapter reports into Pi's events and messages. An assistant
 * message collects text, reasoning and tool calls until a tool runs or the
 * turn ends; each tool result is its own message, as in a Pi session.
 */
class TurnRecorder {
  #assistant?: { message: AssistantRecord; blocks: Map<string, number> };
  #tools = new Map<string, ToolState>();
  /** Cumulative text survives flushing an assistant before a tool starts. */
  #blockText = new Map<string, string>();
  #usage: NativeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(
    private readonly session: NativeCodingSession,
    private readonly model: string,
  ) {}

  sink(): NativeTurnSink {
    return {
      limits: (limits) => this.session.reportLimits(limits),
      text: (key, delta) => this.#text("text", key, delta),
      textDone: (key, text) => this.#textDone("text", key, text),
      thinking: (key, delta) => this.#text("thinking", key, delta),
      thinkingDone: (key, text) => this.#textDone("thinking", key, text),
      toolCall: (callId, name, args) => this.#toolCall(callId, name, args),
      toolStarted: (callId) => this.#toolStarted(callId),
      toolUpdate: (callId, result) => {
        const tool = this.#tools.get(callId);
        if (!tool || tool.finished) return;
        this.#toolStarted(callId);
        this.session.emit({
          type: "tool_execution_update",
          toolCallId: callId,
          toolName: tool.name,
          args: tool.args,
          partialResult: result,
        } as AgentSessionEvent);
      },
      toolResult: (callId, result, isError) =>
        this.#toolResult(callId, result, isError),
      usage: (usage, contextWindow, contextTokens) => {
        this.#usage = usage;
        this.session.reportUsage(
          contextTokens ?? usage.input + usage.cacheRead + usage.cacheWrite,
          contextWindow,
        );
      },
      compaction: (phase, result) => {
        if (phase === "start") {
          this.closeAssistant();
          this.session.emit({
            type: "compaction_start",
            reason: "manual",
          } as AgentSessionEvent);
        } else {
          this.session.sessionManager.appendCustomEntry(
            "ohmygame-native-compaction",
            { version: 1, ...result },
          );
          this.session.emit({
            type: "compaction_end",
            reason: "manual",
            result:
              result?.summary !== undefined ||
              result?.tokensBefore !== undefined
                ? {
                    summary: result.summary ?? "",
                    tokensBefore: result.tokensBefore ?? 0,
                  }
                : undefined,
            aborted: result?.aborted ?? false,
            willRetry: false,
            ...(result?.error ? { errorMessage: result.error } : {}),
          } as AgentSessionEvent);
        }
      },
      nativeSession: (sessionId) => this.session.recordNativeSession(sessionId),
      requestApproval: (details, options) =>
        this.session.approve(
          details,
          options?.callId ?? this.#lastToolCallId() ?? randomUUID(),
          options?.signal,
        ),
    };
  }

  /** Ends the assistant message in progress, as before a tool runs or a message is steered in. */
  closeAssistant(
    stopReason: "stop" | "toolUse" | "aborted" | "error" = "toolUse",
    errorMessage?: string,
  ): void {
    const current = this.#assistant;
    if (!current) return;
    this.#assistant = undefined;
    const message = current.message;
    for (const [, index] of current.blocks) {
      const block = message.content[index];
      if (block?.type === "text")
        this.#emitUpdate(
          { type: "text_end", contentIndex: index, content: block.text },
          message,
        );
      else if (block?.type === "thinking")
        this.#emitUpdate(
          {
            type: "thinking_end",
            contentIndex: index,
            content: block.thinking,
          },
          message,
        );
    }
    message.stopReason = stopReason;
    message.usage = usageRecord(this.#usage);
    if (errorMessage) message.errorMessage = errorMessage;
    this.session.storeMessage(message as unknown as Record<string, unknown>);
    this.session.emit({
      type: "message_end",
      message,
    } as unknown as AgentSessionEvent);
  }

  finish(outcome: NativeTurnOutcome): void {
    // Tools the agent never finished cannot be finished now.
    for (const [callId, tool] of this.#tools) {
      if (!tool.finished)
        this.#toolResult(
          callId,
          {
            content: [
              {
                type: "text",
                text:
                  outcome.status === "aborted"
                    ? "Stopped"
                    : "The agent did not finish this tool call",
              },
            ],
          },
          true,
        );
    }
    if (outcome.status === "completed") {
      // A native loop may finish after a denied tool without final text.
      // Persist the terminal stop so reload does not invent an interruption.
      if (!this.#assistant)
        this.#assistant = { message: this.#newMessage(), blocks: new Map() };
      this.closeAssistant("stop");
      return;
    }
    const stopReason = outcome.status === "aborted" ? "aborted" : "error";
    const errorMessage =
      outcome.status === "failed" ? outcome.error : undefined;
    if (!this.#assistant)
      this.#assistant = { message: this.#newMessage(), blocks: new Map() };
    this.closeAssistant(stopReason, errorMessage);
  }

  #ensureAssistant(): {
    message: AssistantRecord;
    blocks: Map<string, number>;
  } {
    if (this.#assistant) return this.#assistant;
    const message = this.#newMessage();
    this.#assistant = { message, blocks: new Map() };
    this.session.emit({
      type: "message_start",
      message,
    } as unknown as AgentSessionEvent);
    return this.#assistant;
  }

  #newMessage(): AssistantRecord {
    return {
      role: "assistant",
      content: [],
      api: NATIVE_API,
      provider: this.session.runtime,
      model: this.model,
      usage: usageRecord(this.#usage),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  #text(kind: "text" | "thinking", key: string, delta: string): void {
    if (!delta) return;
    const current = this.#ensureAssistant();
    const blockKey = `${kind}:${key}`;
    this.#blockText.set(
      blockKey,
      (this.#blockText.get(blockKey) ?? "") + delta,
    );
    let index = current.blocks.get(blockKey);
    if (index === undefined) {
      index = current.message.content.length;
      current.message.content.push(
        kind === "text"
          ? { type: "text", text: "" }
          : { type: "thinking", thinking: "" },
      );
      current.blocks.set(blockKey, index);
      this.#emitUpdate(
        {
          type: kind === "text" ? "text_start" : "thinking_start",
          contentIndex: index,
        },
        current.message,
      );
    }
    const block = current.message.content[index];
    if (block?.type === "text") block.text += delta;
    else if (block?.type === "thinking") block.thinking += delta;
    this.#emitUpdate(
      {
        type: kind === "text" ? "text_delta" : "thinking_delta",
        contentIndex: index,
        delta,
      },
      current.message,
    );
  }

  #textDone(kind: "text" | "thinking", key: string, text?: string): void {
    const blockKey = `${kind}:${key}`;
    const seen = this.#blockText.get(blockKey) ?? "";
    let index = this.#assistant?.blocks.get(blockKey);
    if (index === undefined) {
      // A final full-text event can arrive after its message was flushed for
      // a tool. Only an unseen suffix belongs in a new assistant segment.
      const unseen = text?.startsWith(seen) ? text.slice(seen.length) : text;
      if (!unseen) return;
      if (text !== undefined && !text.startsWith(seen))
        this.#blockText.delete(blockKey);
      this.#text(kind, key, unseen);
      index = this.#assistant?.blocks.get(blockKey);
      if (index === undefined) return;
    }
    const current = this.#assistant!;
    const block = current.message.content[index];
    if (block?.type === "text" || block?.type === "thinking") {
      const content = block.type === "text" ? block.text : block.thinking;
      // Earlier portions may already be stored in a message before a tool.
      const prefixLength =
        (this.#blockText.get(blockKey)?.length ?? content.length) -
        content.length;
      const final = text !== undefined ? text.slice(prefixLength) : content;
      if (block.type === "text") block.text = final;
      else block.thinking = final;
      this.#emitUpdate(
        {
          type: kind === "text" ? "text_end" : "thinking_end",
          contentIndex: index,
          content: final,
        },
        current.message,
      );
      if (text !== undefined) this.#blockText.set(blockKey, text);
    }
    current.blocks.delete(blockKey);
  }

  #toolCall(callId: string, name: string, args: Record<string, unknown>): void {
    if (this.#tools.has(callId)) return;
    const current = this.#ensureAssistant();
    const index = current.message.content.length;
    const toolCall = {
      type: "toolCall" as const,
      id: callId,
      name,
      arguments: args,
    };
    current.message.content.push(toolCall);
    this.#tools.set(callId, { name, args, started: false, finished: false });
    this.#emitUpdate(
      { type: "toolcall_start", contentIndex: index },
      current.message,
    );
    this.#emitUpdate(
      { type: "toolcall_end", contentIndex: index, toolCall },
      current.message,
    );
  }

  #toolStarted(callId: string): void {
    const tool = this.#tools.get(callId);
    if (!tool || tool.started) return;
    this.closeAssistant("toolUse");
    tool.started = true;
    this.session.emit({
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: tool.name,
      args: tool.args,
    } as AgentSessionEvent);
  }

  #toolResult(
    callId: string,
    result: NativeToolResult,
    isError: boolean,
  ): void {
    const tool = this.#tools.get(callId);
    if (!tool || tool.finished) return;
    this.#toolStarted(callId);
    tool.finished = true;
    this.session.emit({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: tool.name,
      result,
      isError,
    } as AgentSessionEvent);
    this.session.storeMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName: tool.name,
      content: result.content,
      ...(result.details !== undefined ? { details: result.details } : {}),
      isError,
      timestamp: Date.now(),
    });
  }

  #lastToolCallId(): string | undefined {
    return [...this.#tools].findLast(([, tool]) => !tool.finished)?.[0];
  }

  #emitUpdate(
    assistantMessageEvent: Record<string, unknown>,
    message: AssistantRecord,
  ): void {
    this.session.emit({
      type: "message_update",
      message,
      assistantMessageEvent: { ...assistantMessageEvent, partial: message },
    } as unknown as AgentSessionEvent);
  }
}

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

interface AssistantRecord {
  role: "assistant";
  content: AssistantBlock[];
  api: string;
  provider: string;
  model: string;
  usage: ReturnType<typeof usageRecord>;
  stopReason: string;
  errorMessage?: string;
  timestamp: number;
}

function usageRecord(usage: NativeUsage) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens:
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function latestNativeSession(
  entries: readonly SessionEntry[],
  runtime: AgentRuntimeId,
): StoredNativeSession | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    // Only a completed turn anchors resumable context. A later Pi/native
    // message, compaction or model switch means that anchor is stale.
    if (
      entry?.type === "message" ||
      entry?.type === "compaction" ||
      entry?.type === "model_change"
    )
      return undefined;
    if (entry?.type !== "custom" || entry.customType !== NATIVE_SESSION_ENTRY)
      continue;
    const data = entry.data as Partial<StoredNativeSession> | undefined;
    // A later session of another agent means this agent's earlier one has not seen what came since.
    if (
      data?.version !== 2 ||
      data.state !== "ready" ||
      typeof data.sessionId !== "string" ||
      !data.sessionId
    )
      return undefined;
    return data.runtime === runtime
      ? { version: 2, runtime, state: "ready", sessionId: data.sessionId }
      : undefined;
  }
  return undefined;
}

async function bounded(
  work: Promise<unknown>,
  timeout: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function hasMessages(entries: readonly SessionEntry[]): boolean {
  return entries.some((entry) => entry.type === "message");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text"
        ? [String((part as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("");
}

function approvalKey(details: ApprovalRequestDetails): string {
  return JSON.stringify([
    details.kind,
    details.tool,
    details.command ?? "",
    details.path ?? "",
    details.paths ?? [],
    details.network ?? false,
  ]);
}
