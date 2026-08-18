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
import type { ActiveTurnState, AgentItem, AgentMessagePhase, AgentModelRef, AgentReasoningLevel, AgentStatus, ConversationState, PendingPrompt, ProjectState, PromptImage, PromptReference } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import type { StoredConversation } from "./conversations.js";

export interface CodingSession {
  readonly messages: readonly unknown[];
  prompt(prompt: string, options?: { images?: PiPromptImage[] }): Promise<void>;
  followUp?(prompt: string, images?: PiPromptImage[]): Promise<void>;
  steer?(prompt: string, images?: PiPromptImage[]): Promise<void>;
  clearQueue?(): { steering: string[]; followUp: string[] };
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setModel?(model: RuntimeModel): Promise<void>;
  readonly thinkingLevel?: AgentReasoningLevel;
  setThinkingLevel?(level: AgentReasoningLevel): void;
  setActiveToolsByName?(toolNames: string[]): void;
}

interface PiPromptImage {
  type: "image";
  mimeType: string;
  data: string;
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
      const images = imageContent(message.content);
      if (parsed.text || images.length > 0) items.push({ id: entry.id, turnId, kind: "user", text: parsed.text, ...(images.length ? { images } : {}), timestamp });
      continue;
    }
    if (message.role === "assistant") {
      turnId ??= entry.id;
      let hasAssistantText = false;
      for (const [index, content] of message.content.entries()) {
        if (content.type === "thinking") {
          const thinking = content.thinking.trim();
          if (thinking) {
            items.push({
              id: `${entry.id}:thinking:${index}`,
              turnId,
              kind: "thinking",
              text: thinking,
              status: "complete",
              timestamp,
            });
          }
        } else if (content.type === "text" && content.text) {
          hasAssistantText = true;
          const phase = assistantBlockPhase(content);
          items.push({
            id: `${entry.id}:assistant:${index}`,
            turnId,
            kind: "assistant",
            text: content.text,
            status: assistantStatus(message.stopReason),
            ...(phase ? { phase } : {}),
            timestamp,
            ...(message.stopReason === "error" ? { error: message.errorMessage || "The model request failed" } : {}),
          });
        } else if (content.type === "toolCall") {
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
      if (!hasAssistantText && (message.stopReason === "error" || message.stopReason === "aborted")) {
        items.push({
          id: `${entry.id}:assistant`,
          turnId,
          kind: "assistant",
          text: "",
          status: assistantStatus(message.stopReason),
          timestamp,
          ...(message.stopReason === "error" ? { error: message.errorMessage || "The model request failed" } : {}),
        });
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
  prompt: string;
  images: PromptImage[];
  status: Extract<AgentStatus, "running" | "cancelling">;
  assistantItemIds: Map<number, string>;
  completedAssistantIndexes: Set<number>;
  assistantSequence: number;
  thinkingItemId?: string;
  thinkingSequence: number;
  preparingToolItemIds: Map<number, string>;
  toolItemIds: Map<string, string>;
  startedEventId?: number;
  startedAt?: number;
}

interface QueuedPrompt extends PendingPrompt {
  wirePrompt: string;
  queuedEventId: number;
}

export class AgentManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #sessionLoads = new Map<string, { conversationId: string; promise: Promise<ManagedSession> }>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #conversationStates = new Map<string, ConversationState["agent"]>();
  readonly #runs = new Set<Promise<AgentRunResult>>();
  readonly #pendingPrompts = new Map<string, QueuedPrompt[]>();
  readonly #steeringPrompts = new Map<string, QueuedPrompt[]>();
  readonly #queueMutations = new Map<string, Promise<void>>();
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

  async setReasoningLevel(
    projectId: string,
    conversationId: string,
    level: AgentReasoningLevel,
    persist: () => void,
  ): Promise<AgentReasoningLevel | undefined> {
    if (this.#activeTurns.has(projectId)) throw new Error("Wait for the agent to finish before changing reasoning");
    const managed = this.#sessions.get(projectId);
    if (!managed || managed.conversationId !== conversationId) {
      persist();
      return undefined;
    }
    if (!managed.session.setThinkingLevel) {
      throw new Error("The current agent session cannot change reasoning");
    }
    managed.session.setThinkingLevel(level);
    return managed.session.thinkingLevel ?? level;
  }

  prompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    references: PromptReference[] = [],
    images: PromptImage[] = [],
    turnId = randomUUID(),
  ): { turnId: string; queued: boolean; result?: Promise<AgentRunResult | void> } {
    if (!prompt.trim() && images.length === 0) throw new Error("Prompt must not be empty");
    if (this.#closing) throw new Error("Agent manager is closing");
    const active = this.#activeTurns.get(project.id);
    if (active) {
      if (active.conversationId !== conversation.summary.id) throw new Error("Agent is already running in this project");
      if (active.status === "cancelling") throw new Error("Wait for the agent to stop");
      const key = conversationKey(project.id, conversation.summary.id);
      const wirePrompt = promptWithReferences(prompt, references);
      const result = this.#withQueueMutation(key, async () => {
        const event = this.events.publish(
          project.id,
          "prompt.queued",
          { prompt, references, ...(images.length ? { images } : {}) },
          { conversationId: conversation.summary.id, turnId },
          images.length ? { prompt, references } : undefined,
        );
        const queued = { turnId, prompt, references, images, wirePrompt, queuedEventId: event.id };
        this.#pendingPrompts.set(key, [...(this.#pendingPrompts.get(key) ?? []), queued]);
        try {
          const managed = await this.#getSession(project, conversation);
          const current = this.#activeTurns.get(project.id);
          if (!current || current.conversationId !== conversation.summary.id || current.status !== "running") {
            throw new Error("Agent run is no longer active");
          }
          if (!managed.session.followUp) throw new Error("The current agent session cannot queue follow-ups");
          await managed.session.followUp(wirePrompt, images.length ? images.map(toPiImage) : undefined);
        } catch (cause) {
          const pending = this.#pendingPrompts.get(key) ?? [];
          this.#pendingPrompts.set(key, pending.filter((item) => item.turnId !== turnId));
          this.events.publish(project.id, "prompt.removed", {}, { conversationId: conversation.summary.id, turnId });
          throw cause;
        }
      });
      return { turnId, queued: true, result };
    }

    this.#pendingPrompts.delete(conversationKey(project.id, conversation.summary.id));
    return { turnId, queued: false, result: this.#startPrompt(project, conversation, prompt, references, images, turnId) };
  }

  #startPrompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    references: PromptReference[],
    images: PromptImage[],
    turnId: string,
  ): Promise<AgentRunResult> {

    const active: ActiveTurn = {
      conversationId: conversation.summary.id,
      turnId,
      prompt,
      images,
      status: "running",
      assistantItemIds: new Map(),
      completedAssistantIndexes: new Set(),
      assistantSequence: 0,
      thinkingSequence: 0,
      preparingToolItemIds: new Map(),
      toolItemIds: new Map(),
    };
    this.#activeTurns.set(project.id, active);
    this.#setState(project.id, active.conversationId, { status: "running", turnId });
    const started = this.events.publish(
      project.id,
      "agent.started",
      { prompt, ...(images.length ? { images } : {}) },
      eventScope(active),
      images.length ? { prompt } : undefined,
    );
    active.startedEventId = started.id;
    active.startedAt = Date.parse(started.timestamp);
    const execution = this.#runPrompt(project, conversation, promptWithReferences(prompt, references), images, active);
    let run: Promise<AgentRunResult>;
    run = execution.then(
      async (result) => {
        await this.#finishRun(project, active, run, result);
        return result;
      },
      async (cause) => {
        await this.#finishRun(project, active, run);
        throw cause;
      },
    );
    this.#runs.add(run);
    void run.catch(() => {});
    return run;
  }

  async #runPrompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    images: PromptImage[],
    active: ActiveTurn,
  ): Promise<AgentRunResult> {
    try {
      const managed = await this.#getSession(project, conversation);
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }

      managed.session.setActiveToolsByName?.(this.options.activeToolNames?.() ?? BASE_TOOL_NAMES);
      if (images.length) {
        await managed.session.prompt(prompt, { images: images.map(toPiImage) });
      } else {
        await managed.session.prompt(prompt);
      }
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
    const managed = this.#sessions.get(projectId);
    if (managed?.conversationId === conversationId) {
      const key = conversationKey(projectId, conversationId);
      await this.#withQueueMutation(key, async () => {
        managed.session.clearQueue?.();
        this.#clearPending(projectId, conversationId);
      });
      await managed.session.abort();
    } else {
      this.#clearPending(projectId, conversationId);
    }
  }

  async removePending(projectId: string, conversationId: string, turnId: string): Promise<boolean> {
    const key = conversationKey(projectId, conversationId);
    return this.#withQueueMutation(key, async () => {
      const current = this.#pendingPrompts.get(key) ?? [];
      const index = current.findIndex((item) => item.turnId === turnId);
      if (index < 0) return false;
      const removed = current[index];
      const pending = current.filter((item) => item.turnId !== turnId);
      const steering = this.#steeringPrompts.get(key) ?? [];
      await this.#rebuildQueue(projectId, conversationId, steering, pending);
      this.#pendingPrompts.set(key, pending);
      if (removed.images.length) this.events.expireThrough(projectId, removed.queuedEventId);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId });
      return true;
    });
  }

  async steerPending(projectId: string, conversationId: string, turnId: string): Promise<boolean> {
    const key = conversationKey(projectId, conversationId);
    return this.#withQueueMutation(key, async () => {
      const current = this.#pendingPrompts.get(key) ?? [];
      const index = current.findIndex((item) => item.turnId === turnId);
      if (index < 0) return false;
      const steering = [
        ...(this.#steeringPrompts.get(key) ?? []),
        current[index],
      ];
      const pending = current.filter((item) => item.turnId !== turnId);
      await this.#rebuildQueue(projectId, conversationId, steering, pending);
      this.#steeringPrompts.set(key, steering);
      this.#pendingPrompts.set(key, pending);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId });
      return true;
    });
  }

  async #rebuildQueue(
    projectId: string,
    conversationId: string,
    steering: readonly QueuedPrompt[],
    pending: readonly QueuedPrompt[],
  ): Promise<void> {
    const active = this.#activeTurns.get(projectId);
    if (!active || active.conversationId !== conversationId || active.status !== "running") {
      throw new Error("Agent run is not active");
    }
    const managed = this.#sessions.get(projectId);
    if (!managed || managed.conversationId !== conversationId) throw new Error("Agent session is not active");
    if (!managed.session.clearQueue || !managed.session.followUp || !managed.session.steer) {
      throw new Error("The current agent session cannot modify its message queue");
    }
    const key = conversationKey(projectId, conversationId);
    try {
      await replayQueue(managed.session, steering, pending);
    } catch (cause) {
      try {
        await replayQueue(managed.session, this.#steeringPrompts.get(key) ?? [], this.#pendingPrompts.get(key) ?? []);
      } catch {
        // Rollback is best effort because Pi has no transactional queue API.
      }
      throw cause;
    }
  }

  #withQueueMutation<T>(key: string, mutate: () => Promise<T>): Promise<T> {
    const previous = this.#queueMutations.get(key) ?? Promise.resolve();
    const result = previous.then(mutate, mutate);
    const settled = result.then(() => undefined, () => undefined);
    this.#queueMutations.set(key, settled);
    void settled.then(() => {
      if (this.#queueMutations.get(key) === settled) this.#queueMutations.delete(key);
    });
    return result;
  }

  #clearPending(projectId: string, conversationId: string): void {
    const key = conversationKey(projectId, conversationId);
    const pending = this.#pendingPrompts.get(key) ?? [];
    const steering = this.#steeringPrompts.get(key) ?? [];
    this.#pendingPrompts.delete(key);
    this.#steeringPrompts.delete(key);
    for (const item of steering) {
      if (item.images.length) this.events.expireThrough(projectId, item.queuedEventId);
    }
    for (const item of pending) {
      if (item.images.length) this.events.expireThrough(projectId, item.queuedEventId);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId: item.turnId });
    }
  }

  pendingPrompts(projectId: string, conversationId: string): PendingPrompt[] {
    return (this.#pendingPrompts.get(conversationKey(projectId, conversationId)) ?? []).map(({ turnId, prompt, references, images }) => ({
      turnId, prompt, references, images,
    }));
  }

  activeItem(projectId: string, conversationId: string): Extract<AgentItem, { kind: "user" }> | undefined {
    const active = this.#activeTurns.get(projectId);
    if (!active || active.conversationId !== conversationId) return undefined;
    return {
      id: `${active.turnId}:user`,
      turnId: active.turnId,
      kind: "user",
      text: active.prompt,
      ...(active.images.length ? { images: active.images } : {}),
      ...(active.startedAt === undefined ? {} : { timestamp: active.startedAt }),
    };
  }

  activeStart(projectId: string, conversationId: string): { id: number; timestamp: string } | undefined {
    const active = this.#activeTurns.get(projectId);
    if (!active || active.conversationId !== conversationId || active.startedEventId === undefined || active.startedAt === undefined) return undefined;
    return { id: active.startedEventId, timestamp: new Date(active.startedAt).toISOString() };
  }

  eventImages(projectId: string, conversationId: string | undefined, turnId: string | undefined): PromptImage[] | undefined {
    if (!conversationId || !turnId) return undefined;
    const active = this.#activeTurns.get(projectId);
    if (active?.conversationId === conversationId && active.turnId === turnId) return active.images;
    const pending = this.#pendingPrompts.get(conversationKey(projectId, conversationId));
    const steering = this.#steeringPrompts.get(conversationKey(projectId, conversationId));
    return [...(pending ?? []), ...(steering ?? [])].find((item) => item.turnId === turnId)?.images;
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
    await Promise.allSettled([...this.#queueMutations.values()]);
    for (const managed of sessions) {
      managed.unsubscribe();
      managed.session.dispose();
    }
    this.#sessions.clear();
  }

  async #finishRun(project: ProjectState, active: ActiveTurn, run: Promise<AgentRunResult>, result?: AgentRunResult): Promise<void> {
    const projectId = project.id;
    this.#runs.delete(run);
    const key = conversationKey(projectId, active.conversationId);
    await this.#withQueueMutation(key, async () => {
      if (this.#activeTurns.get(projectId) !== active) return;
      this.#activeTurns.delete(projectId);
      if (active.images.length && active.startedEventId !== undefined) this.events.expireThrough(projectId, active.startedEventId);
      if ((this.#pendingPrompts.get(key)?.length ?? 0) > 0 || (this.#steeringPrompts.get(key)?.length ?? 0) > 0) {
        this.#sessions.get(projectId)?.session.clearQueue?.();
      }
      this.#clearPending(projectId, active.conversationId);
      if (result === "completed" && !this.#closing) this.options.onRunCompleted?.(project);
    });
  }

  async #getSession(project: ProjectState, conversation: StoredConversation): Promise<ManagedSession> {
    const existing = this.#sessions.get(project.id);
    if (existing?.conversationId === conversation.summary.id) return existing;
    const loading = this.#sessionLoads.get(project.id);
    if (loading?.conversationId === conversation.summary.id) return loading.promise;
    const promise = this.#loadSession(project, conversation);
    this.#sessionLoads.set(project.id, { conversationId: conversation.summary.id, promise });
    try {
      return await promise;
    } finally {
      if (this.#sessionLoads.get(project.id)?.promise === promise) this.#sessionLoads.delete(project.id);
    }
  }

  async #loadSession(project: ProjectState, conversation: StoredConversation): Promise<ManagedSession> {
    const existing = this.#sessions.get(project.id);
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
    if (event.type === "message_start" && isUserMessage(event.message)) {
      const key = conversationKey(projectId, conversationId);
      const steering = this.#steeringPrompts.get(key) ?? [];
      const pending = this.#pendingPrompts.get(key) ?? [];
      const started = steering[0] ?? pending[0];
      if (!started) return;
      if (steering.length > 0) this.#steeringPrompts.set(key, steering.slice(1));
      else this.#pendingPrompts.set(key, pending.slice(1));
      if (active.images.length && active.startedEventId !== undefined) this.events.expireThrough(projectId, active.startedEventId);
      if (started.images.length) this.events.expireThrough(projectId, started.queuedEventId);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId: started.turnId });
      active.turnId = started.turnId;
      active.prompt = started.prompt;
      active.images = started.images;
      active.assistantItemIds.clear();
      active.completedAssistantIndexes.clear();
      active.assistantSequence = 0;
      active.thinkingItemId = undefined;
      active.thinkingSequence = 0;
      active.preparingToolItemIds.clear();
      active.toolItemIds.clear();
      this.#setState(projectId, conversationId, { status: "running", turnId: started.turnId });
      const startedEvent = this.events.publish(
        projectId,
        "agent.started",
        { prompt: started.prompt, ...(started.images.length ? { images: started.images } : {}) },
        eventScope(active),
        started.images.length ? { prompt: started.prompt } : undefined,
      );
      active.startedEventId = startedEvent.id;
      active.startedAt = Date.parse(startedEvent.timestamp);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
      const itemId = `${active.turnId}:assistant:${active.assistantSequence++}`;
      active.assistantItemIds.set(event.assistantMessageEvent.contentIndex, itemId);
      active.completedAssistantIndexes.delete(event.assistantMessageEvent.contentIndex);
      this.events.publish(projectId, "assistant.started", { itemId }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
      active.thinkingItemId = `${active.turnId}:thinking:${active.thinkingSequence++}`;
      this.events.publish(projectId, "assistant.thinking.started", { itemId: active.thinkingItemId }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      const itemId = active.thinkingItemId ?? `${active.turnId}:thinking:${active.thinkingSequence++}`;
      if (!active.thinkingItemId) {
        active.thinkingItemId = itemId;
        this.events.publish(projectId, "assistant.thinking.started", { itemId }, eventScope(active));
      }
      this.events.publish(projectId, "assistant.thinking.delta", { itemId, delta: event.assistantMessageEvent.delta }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") {
      if (active.thinkingItemId) {
        this.events.publish(projectId, "assistant.thinking.completed", {
          itemId: active.thinkingItemId,
          text: event.assistantMessageEvent.content,
        }, eventScope(active));
        active.thinkingItemId = undefined;
      }
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const itemId = active.assistantItemIds.get(contentIndex) ?? `${active.turnId}:assistant:${active.assistantSequence++}`;
      if (!active.assistantItemIds.has(contentIndex)) {
        active.assistantItemIds.set(contentIndex, itemId);
        this.events.publish(projectId, "assistant.started", { itemId }, eventScope(active));
      }
      this.events.publish(projectId, "assistant.delta", { itemId, delta: event.assistantMessageEvent.delta }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const itemId = active.assistantItemIds.get(contentIndex);
      if (itemId) {
        const phase = assistantBlockPhase(event.assistantMessageEvent.partial.content[contentIndex]);
        this.events.publish(projectId, "assistant.completed", {
          itemId,
          status: "complete",
          ...(phase ? { phase } : {}),
        }, eventScope(active));
        active.completedAssistantIndexes.add(contentIndex);
      }
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const toolCall = partialToolCall(event.assistantMessageEvent.partial, contentIndex);
      const itemId = `${active.turnId}:tool:${active.assistantSequence++}`;
      const toolCallId = toolCall?.id || `${active.turnId}:preparing:${contentIndex}`;
      active.preparingToolItemIds.set(contentIndex, itemId);
      if (toolCall?.id) active.toolItemIds.set(toolCall.id, itemId);
      this.events.publish(projectId, "tool.preparing", {
        itemId,
        toolCallId,
        toolName: toolCall?.name || "tool",
      }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
      const { contentIndex, toolCall } = event.assistantMessageEvent;
      const itemId = active.preparingToolItemIds.get(contentIndex) ?? `${active.turnId}:tool:${active.assistantSequence++}`;
      active.preparingToolItemIds.delete(contentIndex);
      active.toolItemIds.set(toolCall.id, itemId);
      this.events.publish(projectId, "tool.preparing", {
        itemId,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolArguments(toolCall.name, toolCall.arguments),
      }, eventScope(active));
    } else if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const status = assistantStatus(event.message.stopReason);
      for (const [contentIndex, itemId] of active.assistantItemIds) {
        if (status === "complete" && active.completedAssistantIndexes.has(contentIndex)) continue;
        const phase = assistantBlockPhase(Array.isArray(event.message.content) ? event.message.content[contentIndex] : undefined);
        this.events.publish(projectId, "assistant.completed", {
          itemId,
          status,
          ...(phase ? { phase } : {}),
          ...(event.message.stopReason === "error" ? { error: event.message.errorMessage || "The model request failed" } : {}),
        }, eventScope(active));
      }
      if (active.assistantItemIds.size === 0 && status !== "complete") {
        const itemId = `${active.turnId}:assistant:${active.assistantSequence++}`;
        this.events.publish(projectId, "assistant.started", { itemId }, eventScope(active));
        this.events.publish(projectId, "assistant.completed", {
          itemId,
          status,
          ...(event.message.stopReason === "error" ? { error: event.message.errorMessage || "The model request failed" } : {}),
        }, eventScope(active));
      }
      active.assistantItemIds.clear();
      active.completedAssistantIndexes.clear();
      active.preparingToolItemIds.clear();
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
      const itemId = active.toolItemIds.get(event.toolCallId) ?? `${active.turnId}:tool:${event.toolCallId}`;
      active.toolItemIds.set(event.toolCallId, itemId);
      this.events.publish(projectId, "tool.started", {
        itemId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: toolArguments(event.toolName, event.args),
      }, eventScope(active));
    } else if (event.type === "tool_execution_update") {
      const result = toolOutput(event.partialResult);
      this.events.publish(projectId, "tool.updated", {
        itemId: active.toolItemIds.get(event.toolCallId) ?? `${active.turnId}:tool:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        ...result,
      }, eventScope(active));
    } else if (event.type === "tool_execution_end") {
      const result = toolOutput(event.result);
      this.events.publish(projectId, "tool.completed", {
        itemId: active.toolItemIds.get(event.toolCallId) ?? `${active.turnId}:tool:${event.toolCallId}`,
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

  forgetProject(projectId: string): void {
    const managed = this.#sessions.get(projectId);
    if (managed) {
      managed.unsubscribe();
      managed.session.dispose();
      this.#sessions.delete(projectId);
    }
    for (const key of this.#conversationStates.keys()) {
      if (key.startsWith(`${projectId}:`)) this.#conversationStates.delete(key);
    }
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

function assistantBlockPhase(content: unknown): AgentMessagePhase | undefined {
  if (!content || typeof content !== "object" || (content as { type?: unknown }).type !== "text") return undefined;
  const direct = (content as { phase?: unknown }).phase;
  if (direct === "commentary" || direct === "final_answer") return direct;
  const signature = (content as { textSignature?: unknown }).textSignature;
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try {
    const phase = (JSON.parse(signature) as { phase?: unknown }).phase;
    return phase === "commentary" || phase === "final_answer" ? phase : undefined;
  } catch {
    return undefined;
  }
}

function imageContent(content: unknown): PromptImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "image") return [];
    const mediaType = (item as { mimeType?: unknown }).mimeType;
    const data = (item as { data?: unknown }).data;
    if (!isPromptImageMediaType(mediaType) || typeof data !== "string") return [];
    return [{ mediaType, data }];
  });
}

function isPromptImageMediaType(value: unknown): value is PromptImage["mediaType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function toPiImage(image: PromptImage): PiPromptImage {
  return { type: "image", mimeType: image.mediaType, data: image.data };
}

async function replayQueue(
  session: CodingSession,
  steering: readonly QueuedPrompt[],
  pending: readonly QueuedPrompt[],
): Promise<void> {
  session.clearQueue!();
  for (const item of steering) {
    await session.steer!(item.wirePrompt, item.images.length ? item.images.map(toPiImage) : undefined);
  }
  for (const item of pending) {
    await session.followUp!(item.wirePrompt, item.images.length ? item.images.map(toPiImage) : undefined);
  }
}

function assistantStatus(stopReason: string): "complete" | "cancelled" | "error" {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "cancelled";
  return "complete";
}

function isAssistantMessage(message: unknown): message is {
  role: "assistant";
  content: unknown;
  stopReason: string;
  errorMessage?: string;
} {
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "assistant");
}

function isUserMessage(message: unknown): message is { role: "user"; content: unknown } {
  return Boolean(message && typeof message === "object" && (message as { role?: unknown }).role === "user");
}

function partialToolCall(message: unknown, contentIndex: number): { id: string; name: string } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content[contentIndex];
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "toolCall") return undefined;
  const id = (block as { id?: unknown }).id;
  const name = (block as { name?: unknown }).name;
  return {
    id: typeof id === "string" ? id : "",
    name: typeof name === "string" ? name : "",
  };
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
      "For tasks that require several tool calls, send a brief commentary update before the first tool call and whenever you discover something important or begin a new major step. " +
      "Keep commentary concise, do not narrate routine tool calls, and reserve the final answer for the completed result.",
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
