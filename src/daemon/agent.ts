import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActiveTurnState, AgentItem, AgentModelRef, AgentStatus, ConversationState, PendingPrompt, ProjectState, PromptReference } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import type { StoredConversation } from "./conversations.js";

export interface CodingSession {
  readonly messages: readonly unknown[];
  prompt(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setModel?(model: RuntimeModel): Promise<void>;
  setActiveToolsByName?(toolNames: string[]): void;
}

export type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export type AgentRunResult = "completed" | "cancelled";
export type SessionFactory = (project: ProjectState, conversation: StoredConversation) => Promise<CodingSession>;

export function loadConversation(workspacePath: string, sessionPath: string, before?: string, markInterrupted = true): AgentItem[] {
  const sessionDirectory = path.join(path.dirname(workspacePath), "session");
  const entries = SessionManager.open(sessionPath, sessionDirectory, workspacePath).getBranch();
  return conversationItems(before ? entries.filter((entry) => entry.timestamp < before) : entries, markInterrupted);
}

export function conversationItems(entries: readonly SessionEntry[], markInterrupted = true): AgentItem[] {
  const items: AgentItem[] = [];
  const tools = new Map<string, Extract<AgentItem, { kind: "tool" }>>();
  let turnId: string | undefined;
  let turnFinished = true;
  let lastTimestamp: number | undefined;

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    const timestamp = messageTime(entry);
    if (timestamp !== undefined) lastTimestamp = timestamp;
    if (message.role === "user") {
      turnId = entry.id;
      turnFinished = false;
      const parsed = parseUserPrompt(textContent(message.content));
      if (parsed.text) items.push({ id: entry.id, turnId, kind: "user", text: parsed.text, timestamp });
      continue;
    }
    if (message.role === "assistant") {
      turnId ??= entry.id;
      const text = textContent(message.content);
      if (text || message.stopReason === "error" || message.stopReason === "aborted") {
        items.push({
          id: `${entry.id}:assistant`,
          turnId,
          kind: "assistant",
          text,
          status: assistantStatus(message.stopReason),
          timestamp,
          ...(message.stopReason === "error" ? { error: message.errorMessage || "The model request failed" } : {}),
        });
      }
      for (const content of message.content) {
        if (content.type === "toolCall") {
          const tool: Extract<AgentItem, { kind: "tool" }> = {
            id: `${entry.id}:tool:${content.id}`,
            turnId,
            kind: "tool",
            toolCallId: content.id,
            toolName: content.name,
            status: "running",
            args: toolArguments(content.name, content.arguments),
            timestamp,
          };
          tools.set(content.id, tool);
          items.push(tool);
        }
      }
      if (message.stopReason !== "toolUse") turnFinished = true;
      continue;
    }
    if (message.role === "toolResult") {
      const tool = tools.get(message.toolCallId);
      if (tool) {
        tool.status = message.isError ? "error" : "complete";
        tool.timestamp = timestamp;
        const result = toolOutput(message);
        if (result.output) tool.output = result.output;
        if (result.truncated) tool.truncated = true;
      }
    }
  }

  if (markInterrupted && turnId && !turnFinished) {
    items.push({ id: `${turnId}:interrupted`, turnId, kind: "assistant", text: "", status: "interrupted", timestamp: lastTimestamp });
  }

  return items.map((item) => markInterrupted && item.kind === "tool" && item.status === "running"
    ? { ...item, status: "error" }
    : item);
}

function messageTime(entry: Extract<SessionEntry, { type: "message" }>): number | undefined {
  const messageTimestamp = (entry.message as { timestamp?: unknown }).timestamp;
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
  const entryTimestamp = Date.parse(entry.timestamp);
  return Number.isFinite(entryTimestamp) ? entryTimestamp : undefined;
}

interface AgentManagerOptions {
  createSession?: SessionFactory;
  activeToolNames?: () => string[];
  onRunCompleted?: (project: ProjectState) => void;
}

interface ManagedSession {
  conversationId: string;
  session: CodingSession;
  unsubscribe: () => void;
}

interface ActiveTurn {
  conversationId: string;
  turnId: string;
  status: Extract<AgentStatus, "running" | "cancelling">;
  assistantItemId?: string;
  assistantSequence: number;
}

interface QueuedPrompt extends PendingPrompt {
  project: ProjectState;
  conversation: StoredConversation;
}

export class AgentManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #conversationStates = new Map<string, ConversationState["agent"]>();
  readonly #runs = new Set<Promise<AgentRunResult>>();
  readonly #pendingPrompts = new Map<string, QueuedPrompt>();
  #closing = false;

  constructor(
    private readonly events: RuntimeEventBus,
    private readonly options: AgentManagerOptions = {},
  ) {}

  state(conversation: StoredConversation, model?: AgentModelRef): ConversationState {
    return {
      ...conversation.summary,
      agent: this.#conversationStates.get(conversationKey(conversation.summary.projectId, conversation.summary.id)) ?? { status: "idle" },
      ...(model ? { model } : {}),
    };
  }

  async setModel(
    projectId: string,
    conversationId: string,
    model: RuntimeModel,
    persist: () => void,
  ): Promise<void> {
    if (this.#activeTurns.has(projectId)) throw new Error("Wait for the agent to finish before changing models");
    const managed = this.#sessions.get(projectId);
    if (!managed || managed.conversationId !== conversationId) {
      persist();
      return;
    }
    if (!managed.session.setModel) throw new Error("The current agent session cannot change models");
    await managed.session.setModel(model);
  }

  prompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    references: PromptReference[] = [],
    turnId = randomUUID(),
  ): { turnId: string; queued: boolean; result?: Promise<AgentRunResult> } {
    if (!prompt.trim()) throw new Error("Prompt must not be empty");
    if (this.#closing) throw new Error("Agent manager is closing");
    const active = this.#activeTurns.get(project.id);
    if (active) {
      if (active.conversationId !== conversation.summary.id) throw new Error("Agent is already running in this project");
      if (active.status === "cancelling") throw new Error("Wait for the agent to stop");
      const queued = { turnId, prompt, references, project, conversation };
      this.#pendingPrompts.set(conversationKey(project.id, conversation.summary.id), queued);
      this.events.publish(project.id, "prompt.queued", { prompt, references }, { conversationId: conversation.summary.id, turnId });
      return { turnId, queued: true };
    }

    this.#pendingPrompts.delete(conversationKey(project.id, conversation.summary.id));
    return { turnId, queued: false, result: this.#startPrompt(project, conversation, prompt, references, turnId) };
  }

  #startPrompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    references: PromptReference[],
    turnId: string,
  ): Promise<AgentRunResult> {

    const active: ActiveTurn = { conversationId: conversation.summary.id, turnId, status: "running", assistantSequence: 0 };
    this.#activeTurns.set(project.id, active);
    this.#setState(project.id, active.conversationId, { status: "running", turnId });
    this.events.publish(project.id, "agent.started", { prompt }, eventScope(active));
    const run = this.#runPrompt(project, conversation, promptWithReferences(prompt, references), active);
    this.#runs.add(run);
    void run.then(
      (result) => this.#finishRun(project, active, run, result),
      () => this.#finishRun(project, active, run),
    );
    return run;
  }

  async #runPrompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    active: ActiveTurn,
  ): Promise<AgentRunResult> {
    try {
      const managed = await this.#getSession(project, conversation);
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }

      managed.session.setActiveToolsByName?.(this.options.activeToolNames?.() ?? BASE_TOOL_NAMES);
      await managed.session.prompt(prompt);
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }

      const sessionError = lastAssistantError(managed.session.messages);
      if (sessionError) {
        throw new Error(sessionError);
      }

      this.#setState(project.id, active.conversationId, { status: "idle" });
      this.events.publish(project.id, "agent.completed", {}, eventScope(active));
      return "completed";
    } catch (cause) {
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }
      const error = cause instanceof Error ? cause.message : String(cause);
      this.#markError(project.id, active, error);
      throw cause;
    }
  }

  async cancel(projectId: string, conversationId: string, turnId: string): Promise<void> {
    const active = this.#activeTurns.get(projectId);
    if (!active || active.conversationId !== conversationId || active.turnId !== turnId || active.status !== "running") return;
    active.status = "cancelling";
    this.#setState(projectId, conversationId, { status: "cancelling", turnId });
    this.#clearPending(projectId, conversationId);
    const managed = this.#sessions.get(projectId);
    if (managed?.conversationId === conversationId) await managed.session.abort();
  }

  removePending(projectId: string, conversationId: string, turnId: string): boolean {
    const key = conversationKey(projectId, conversationId);
    const pending = this.#pendingPrompts.get(key);
    if (!pending || pending.turnId !== turnId) return false;
    this.#clearPending(projectId, conversationId);
    return true;
  }

  #clearPending(projectId: string, conversationId: string): void {
    const key = conversationKey(projectId, conversationId);
    const pending = this.#pendingPrompts.get(key);
    if (!pending) return;
    this.#pendingPrompts.delete(key);
    this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId: pending.turnId });
  }

  pendingPrompt(projectId: string, conversationId: string): PendingPrompt | undefined {
    const pending = this.#pendingPrompts.get(conversationKey(projectId, conversationId));
    return pending ? { turnId: pending.turnId, prompt: pending.prompt, references: pending.references } : undefined;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const [projectId, active] of this.#activeTurns) {
      active.status = "cancelling";
      this.#setState(projectId, active.conversationId, { status: "cancelling", turnId: active.turnId });
    }
    const sessions = [...this.#sessions.values()];
    await Promise.allSettled(sessions.map(({ session }) => session.abort()));
    await Promise.allSettled([...this.#runs]);
    for (const managed of sessions) {
      managed.unsubscribe();
      managed.session.dispose();
    }
    this.#sessions.clear();
  }

  #finishRun(project: ProjectState, active: ActiveTurn, run: Promise<AgentRunResult>, result?: AgentRunResult): void {
    const projectId = project.id;
    this.#runs.delete(run);
    if (this.#activeTurns.get(projectId) !== active) return;
    this.#activeTurns.delete(projectId);
    const key = conversationKey(projectId, active.conversationId);
    const pending = this.#pendingPrompts.get(key);
    if (!pending || this.#closing) {
      if (result === "completed" && !this.#closing) this.options.onRunCompleted?.(project);
      return;
    }
    if (result !== "completed") {
      this.#pendingPrompts.delete(key);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId: active.conversationId, turnId: pending.turnId });
      return;
    }
    this.#pendingPrompts.delete(key);
    this.#startPrompt(pending.project, pending.conversation, pending.prompt, pending.references, pending.turnId);
  }

  async #getSession(project: ProjectState, conversation: StoredConversation): Promise<ManagedSession> {
    const existing = this.#sessions.get(project.id);
    if (existing?.conversationId === conversation.summary.id) return existing;
    if (existing) {
      existing.unsubscribe();
      existing.session.dispose();
      this.#sessions.delete(project.id);
    }

    const session = await (this.options.createSession ?? ((state, stored) => createPiSession(
      state.workspacePath,
      SessionManager.open(stored.sessionPath, path.join(path.dirname(state.workspacePath), "session"), state.workspacePath),
      [],
    )))(project, conversation);
    if (this.#closing) {
      session.dispose();
      throw new Error("Agent manager is closing");
    }
    const unsubscribe = session.subscribe((event) => this.#forwardEvent(project.id, conversation.summary.id, event));
    const managed = { conversationId: conversation.summary.id, session, unsubscribe };
    this.#sessions.set(project.id, managed);
    return managed;
  }

  #forwardEvent(projectId: string, conversationId: string, event: AgentSessionEvent): void {
    const active = this.#activeTurns.get(projectId);
    if (!active || active.conversationId !== conversationId) return;
    if (event.type === "message_start" && isAssistantMessage(event.message)) {
      active.assistantItemId = `${active.turnId}:assistant:${active.assistantSequence++}`;
      this.events.publish(projectId, "assistant.started", { itemId: active.assistantItemId }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
      this.events.publish(projectId, "assistant.thinking", {}, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const itemId = active.assistantItemId ?? `${active.turnId}:assistant:${active.assistantSequence++}`;
      if (!active.assistantItemId) {
        active.assistantItemId = itemId;
        this.events.publish(projectId, "assistant.started", { itemId }, eventScope(active));
      }
      this.events.publish(projectId, "assistant.delta", { itemId, delta: event.assistantMessageEvent.delta }, eventScope(active));
    } else if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const itemId = active.assistantItemId ?? `${active.turnId}:assistant:${active.assistantSequence++}`;
      if (!active.assistantItemId) this.events.publish(projectId, "assistant.started", { itemId }, eventScope(active));
      this.events.publish(projectId, "assistant.completed", {
        itemId,
        status: assistantStatus(event.message.stopReason),
        ...(event.message.stopReason === "error" ? { error: event.message.errorMessage || "The model request failed" } : {}),
      }, eventScope(active));
      active.assistantItemId = undefined;
    } else if (event.type === "auto_retry_start") {
      this.events.publish(projectId, "agent.retrying", {
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: event.errorMessage,
      }, eventScope(active));
    } else if (event.type === "compaction_start") {
      this.events.publish(projectId, "agent.compaction.started", { reason: event.reason }, eventScope(active));
    } else if (event.type === "compaction_end") {
      this.events.publish(projectId, "agent.compaction.completed", {
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.errorMessage ? { error: event.errorMessage } : {}),
      }, eventScope(active));
    } else if (event.type === "tool_execution_start") {
      const itemId = `${active.turnId}:tool:${event.toolCallId}`;
      this.events.publish(projectId, "tool.started", {
        itemId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: toolArguments(event.toolName, event.args),
      }, eventScope(active));
    } else if (event.type === "tool_execution_update") {
      const result = toolOutput(event.partialResult);
      this.events.publish(projectId, "tool.updated", {
        itemId: `${active.turnId}:tool:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        ...result,
      }, eventScope(active));
    } else if (event.type === "tool_execution_end") {
      const result = toolOutput(event.result);
      this.events.publish(projectId, "tool.completed", {
        itemId: `${active.turnId}:tool:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        ...result,
      }, eventScope(active));
    }
  }

  #markCancelled(projectId: string, active: ActiveTurn): void {
    this.#setState(projectId, active.conversationId, { status: "idle" });
    this.events.publish(projectId, "agent.cancelled", {}, eventScope(active));
  }

  #markError(projectId: string, active: ActiveTurn, error: string): void {
    this.#setState(projectId, active.conversationId, { status: "error", error });
    this.events.publish(projectId, "agent.error", { error }, eventScope(active));
  }

  #setState(projectId: string, conversationId: string, state: ConversationState["agent"]): void {
    this.#conversationStates.set(conversationKey(projectId, conversationId), state);
  }

  isProjectBusy(projectId: string): boolean {
    return this.#activeTurns.has(projectId);
  }

  activeTurn(projectId: string): ActiveTurnState | undefined {
    const active = this.#activeTurns.get(projectId);
    return active ? { conversationId: active.conversationId, turnId: active.turnId } : undefined;
  }
}

const REFERENCE_MARKER = "<workspace-file-references>";

function promptWithReferences(prompt: string, references: PromptReference[]): string {
  if (references.length === 0) return prompt;
  return `${prompt}\n\n${REFERENCE_MARKER}\n${JSON.stringify(references.map(({ path }) => path))}\n</workspace-file-references>`;
}

function parseUserPrompt(value: string): { text: string } {
  const marker = `\n\n${REFERENCE_MARKER}\n`;
  const index = value.lastIndexOf(marker);
  return { text: index < 0 ? value : value.slice(0, index) };
}

function conversationKey(projectId: string, conversationId: string): string {
  return `${projectId}:${conversationId}`;
}

function isCancelling(turn: ActiveTurn): boolean {
  return turn.status === "cancelling";
}

function eventScope(turn: ActiveTurn): { conversationId: string; turnId: string } {
  return { conversationId: turn.conversationId, turnId: turn.turnId };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(
      item && typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
    ))
    .map((item) => item.text)
    .join("");
}

function assistantStatus(stopReason: string): "complete" | "cancelled" | "error" {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "cancelled";
  return "complete";
}

function isAssistantMessage(message: unknown): message is {
  role: "assistant";
  stopReason: string;
  errorMessage?: string;
} {
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

const MAX_TOOL_OUTPUT = 12_000;
const MAX_GENERIC_TOOL_ARGUMENTS = 2_000;

function toolArguments(toolName: string, args: unknown): unknown {
  const values = record(args);
  if (!values) return boundedValue(args);

  switch (toolName) {
    case "bash": return boundedValue(compactRecord(values, ["command", "timeout"]));
    case "read": return boundedValue(compactRecord(values, ["path", "offset", "limit"]));
    case "write":
    case "edit": return boundedValue(compactRecord(values, ["path", "file_path"]));
    default: return boundedValue(args);
  }
}

function compactRecord(values: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const result = Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return String(value).slice(0, MAX_GENERIC_TOOL_ARGUMENTS);
  }
  if (serialized === undefined) return String(value).slice(0, MAX_GENERIC_TOOL_ARGUMENTS);
  if (serialized.length <= MAX_GENERIC_TOOL_ARGUMENTS) return JSON.parse(serialized) as unknown;
  return `${serialized.slice(0, MAX_GENERIC_TOOL_ARGUMENTS)}\n... arguments truncated ...`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolOutput(result: unknown): { output?: string; truncated?: boolean } {
  const value = result && typeof result === "object" && "content" in result
    ? textContent((result as { content?: unknown }).content)
    : stringify(result);
  if (!value) return {};
  if (value.length <= MAX_TOOL_OUTPUT) return { output: value };
  const half = MAX_TOOL_OUTPUT / 2;
  return {
    output: `${value.slice(0, half)}\n\n... output truncated ...\n\n${value.slice(-half)}`,
    truncated: true,
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const BASE_TOOL_NAMES = ["read", "write", "edit", "bash"];

export async function createPiSession(
  workspacePath: string,
  sessionManager: SessionManager,
  customTools: ToolDefinition[] = [],
  modelRuntime?: ModelRuntime,
  model?: RuntimeModel,
): Promise<CodingSession> {
  // Trusted-local phase: cwd guides Pi but is not an OS security boundary.
  const persistedSettings = SettingsManager.create(workspacePath, getAgentDir());
  const sessionSettings = SettingsManager.inMemory(persistedSettings.getGlobalSettings());
  sessionSettings.applyOverrides(persistedSettings.getProjectSettings());
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir: getAgentDir(),
    settingsManager: sessionSettings,
    appendSystemPrompt: [
      "This workspace may be empty. Do not create files for casual conversation or questions that do not require code. " +
      "When the user asks you to build a game or web app in this workspace, create it as a complete Vite-based browser project whose package.json has non-empty scripts.dev and scripts.build commands, with the build producing a static dist/index.html. " +
      "Do not leave a long-running development server active; the host starts the preview after your turn.",
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: workspacePath,
    customTools,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager: sessionSettings,
  });
  return session;
}

export function lastAssistantError(messages: readonly unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const candidate = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
    if (candidate.role !== "assistant") continue;
    if (candidate.stopReason === "error") {
      return typeof candidate.errorMessage === "string" && candidate.errorMessage
        ? candidate.errorMessage
        : "The model request failed";
    }
    return undefined;
  }
  return undefined;
}
