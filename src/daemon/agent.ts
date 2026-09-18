import {
  createAgentSession,
  DefaultResourceLoader,
  loadSkills,
  ModelRuntime,
  parseSkillBlock,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type SessionEntry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentContextUsage, AgentMessagePhase, AgentReasoningLevel, AgentStatus, ConversationAgentState, PendingPrompt, PlanMode, PlanSessionState, PlanState, PluginMention, ProjectState, PromptImage, PromptReference, QuestionnaireAnswer, QuestionnaireQuestion, QuestionnaireResult, ThreadItem, ThreadItemError, ToolArtifact } from "../shared/contracts.js";
import { hasPluginMentionToken, parsePluginMentions, serializePluginMentions } from "../shared/plugins.js";
import type { RuntimeEventBus } from "../shared/events.js";
import type { StoredConversation } from "./conversations.js";
import { ensureOhMyGamePiEnvironment, withRequiredPiPackages } from "./pi-agent.js";
import { mcpToolInput, parseMcpToolIdentity } from "../shared/mcp.js";
import type { PluginSkillRegistration } from "./plugin-runtime.js";

export interface CodingSession {
  readonly messages: readonly unknown[];
  readonly sessionManager?: Pick<SessionManager, "appendCustomEntry" | "getBranch">;
  prompt(prompt: string, options?: { images?: PiPromptImage[] }): Promise<void>;
  followUp?(prompt: string, images?: PiPromptImage[]): Promise<void>;
  steer?(prompt: string, images?: PiPromptImage[]): Promise<void>;
  compact?(customInstructions?: string): Promise<unknown>;
  getContextUsage?(): AgentContextUsage | undefined;
  clearQueue?(): { steering: string[]; followUp: string[] };
  navigateTree?(targetId: string, options?: { summarize?: boolean }): Promise<{ editorText?: string; cancelled: boolean }>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setModel?(model: RuntimeModel): Promise<void>;
  readonly thinkingLevel?: AgentReasoningLevel;
  setThinkingLevel?(level: AgentReasoningLevel): void;
  setActiveToolsByName?(toolNames: string[]): void;
  getAllTools?(): Array<{ name: string }>;
  getSkills?(): SkillCatalogItem[];
}

export interface SkillCatalogItem {
  name: string;
  description: string;
  pluginDisplayName?: string;
  marketplaceDisplayName?: string;
}

interface PiPromptImage {
  type: "image";
  mimeType: string;
  data: string;
}

export type RuntimeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export type AgentRunResult = "completed" | "cancelled";
export type SessionFactory = (project: ProjectState, conversation: StoredConversation) => Promise<CodingSession>;

export function loadConversation(workspacePath: string, sessionPath: string, before?: string, markInterrupted = true): ThreadItem[] {
  const sessionDirectory = path.join(path.dirname(workspacePath), "session");
  const entries = SessionManager.open(sessionPath, sessionDirectory, workspacePath).getBranch();
  return conversationItems(before ? entries.filter((entry) => entry.timestamp < before) : entries, markInterrupted);
}

export function conversationItems(entries: readonly SessionEntry[], markInterrupted = true): ThreadItem[] {
  const items: ThreadItem[] = [];
  const tools = new Map<string, Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>>();
  const planCalls = new Set<string>();
  const questionnaireCalls = new Map<string, Extract<ThreadItem, { type: "userInputRequest" }>>();
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
      if (parsed.text || images.length > 0) items.push({ id: entry.id, turnId, type: "userMessage", text: parsed.text, ...(parsed.mentions.length ? { mentions: parsed.mentions } : {}), ...(images.length ? { images } : {}), timestamp });
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
              type: "reasoning",
              text: thinking,
              status: "completed",
              timestamp,
            });
          }
        } else if (content.type === "text" && content.text) {
          hasAssistantText = true;
          const phase = assistantMessagePhase(content, message.stopReason);
          items.push({
            id: `${entry.id}:assistant:${index}`,
            turnId,
            type: "agentMessage",
            text: content.text,
            status: threadItemStatus(message.stopReason),
            ...(phase ? { phase } : {}),
            timestamp,
            ...(message.stopReason === "error" ? { error: itemError(message.errorMessage || "The model request failed") } : {}),
          });
        } else if (content.type === "toolCall") {
          if (content.name === "update_plan") {
            planCalls.add(content.id);
            continue;
          }
          if (content.name === "questionnaire") {
            const item = questionnaireThreadItem(turnId, content.id, content.arguments, timestamp);
            if (item) {
              questionnaireCalls.set(content.id, item);
              items.push(item);
            }
            continue;
          }
          const args = toolArguments(content.name, content.arguments);
          const mcp = parseMcpToolIdentity(content.name, args);
          const tool: Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }> = mcp ? {
            id: `${entry.id}:tool:${content.id}`,
            turnId,
            type: "mcpToolCall",
            toolCallId: content.id,
            ...mcp,
            status: "inProgress",
            arguments: mcpToolInput(args),
            timestamp,
          } : {
            id: `${entry.id}:tool:${content.id}`,
            turnId,
            type: "dynamicToolCall",
            toolCallId: content.id,
            tool: content.name,
            status: "inProgress",
            arguments: args,
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
          type: "agentMessage",
          text: "",
          status: threadItemStatus(message.stopReason),
          timestamp,
          ...(message.stopReason === "error" ? { error: itemError(message.errorMessage || "The model request failed") } : {}),
        });
      }
      if (message.stopReason !== "toolUse") turnFinished = true;
      continue;
    }
    if (message.role === "toolResult") {
      const questionnaire = questionnaireCalls.get(message.toolCallId);
      if (questionnaire) {
        const result = questionnaireResult(message);
        const completed: typeof questionnaire = message.isError
          ? { ...questionnaire, status: "failed", error: itemError(toolOutput(message).output || "Questionnaire failed"), timestamp }
          : result?.cancelled
            ? { ...questionnaire, status: "cancelled", answers: [], timestamp }
            : { ...questionnaire, status: "completed", ...(result ? { answers: result.answers } : {}), timestamp };
        questionnaireCalls.set(message.toolCallId, completed);
        const index = items.findIndex((item) => item.id === completed.id);
        if (index >= 0) items[index] = completed;
        continue;
      }
      if (planCalls.has(message.toolCallId)) {
        if (message.isError) continue;
        const plan = toolPlan(message);
        if (plan && turnId) {
          const item: ThreadItem = { id: `${turnId}:plan`, turnId, type: "plan", plan, timestamp };
          const index = items.findIndex((candidate) => candidate.id === item.id);
          if (index < 0) items.push(item);
          else items[index] = item;
        }
        continue;
      }
      const tool = tools.get(message.toolCallId);
      if (tool) {
        tool.status = message.isError ? "failed" : "completed";
        tool.timestamp = timestamp;
        const result = toolOutput(message);
        if (result.output) tool.output = result.output;
        if (result.truncated) tool.truncated = true;
        if (result.artifact) tool.artifact = result.artifact;
      }
    }
  }

  if (markInterrupted && turnId && !turnFinished) {
    items.push({ id: `${turnId}:interrupted`, turnId, type: "agentMessage", text: "", status: "interrupted", timestamp: lastTimestamp });
  }

  return items.map((item) => {
    if (!markInterrupted) return item;
    if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && item.status === "inProgress") {
      return { ...item, status: "failed" };
    }
    if (item.type === "userInputRequest" && item.status === "inProgress") {
      return { ...item, status: "failed", error: itemError("Questionnaire interrupted") };
    }
    return item;
  });
}

function messageTime(entry: Extract<SessionEntry, { type: "message" }>): number | undefined {
  const messageTimestamp = (entry.message as { timestamp?: unknown }).timestamp;
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
  const entryTimestamp = Date.parse(entry.timestamp);
  return Number.isFinite(entryTimestamp) ? entryTimestamp : undefined;
}

interface AgentManagerOptions {
  createSession?: SessionFactory;
  loadSkills?: (project: ProjectState) => Promise<Array<{ name: string; description: string }>>;
  activeToolNames?: (project: ProjectState, mode: PlanMode, session: CodingSession) => string[];
  onRunCompleted?: (project: ProjectState) => void;
}

interface ManagedSession {
  session: CodingSession;
  unsubscribe: () => void;
}

interface ActiveTurn {
  project: ProjectState;
  projectId: string;
  conversationId: string;
  turnId: string;
  prompt: string;
  mentions: PluginMention[];
  images: PromptImage[];
  mode: PlanMode;
  plan?: PlanState;
  conversation: StoredConversation;
  status: Extract<AgentStatus, "running" | "cancelling">;
  assistantItemIds: Map<number, string>;
  completedAssistantIndexes: Set<number>;
  assistantSequence: number;
  thinkingItemId?: string;
  thinkingSequence: number;
  preparingToolItemIds: Map<number, string>;
  toolItemIds: Map<string, string>;
  retryItemId?: string;
  items: Map<string, ThreadItem>;
  startedEventId?: number;
  startedAt?: number;
}

interface QueuedPrompt extends PendingPrompt {
  wirePrompt: string;
  queuedEventId: number;
}

interface PendingQuestionnaire {
  item: Extract<ThreadItem, { type: "userInputRequest" }>;
  resolve: (result: QuestionnaireResult) => void;
  reject: (cause: Error) => void;
  removeAbortListener?: () => void;
}

export class AgentManager {
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #sessionLoads = new Map<string, Promise<ManagedSession>>();
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #agentStates = new Map<string, ConversationAgentState>();
  readonly #planStates = new Map<string, PlanSessionState>();
  readonly #runs = new Set<Promise<AgentRunResult>>();
  readonly #pendingPrompts = new Map<string, QueuedPrompt[]>();
  readonly #steeringPrompts = new Map<string, QueuedPrompt[]>();
  readonly #queueMutations = new Map<string, Promise<void>>();
  readonly #revisions = new Set<string>();
  readonly #questionnaires = new Map<string, PendingQuestionnaire>();
  readonly #invalidatedProjects = new Set<string>();
  #closing = false;

  constructor(
    private readonly events: RuntimeEventBus,
    private readonly options: AgentManagerOptions = {},
  ) {}

  agentState(conversation: StoredConversation): ConversationAgentState {
    return this.#agentStates.get(conversationKey(conversation.summary.projectId, conversation.summary.id)) ?? { status: "idle" };
  }

  restorePlanState(conversation: StoredConversation, state: PlanSessionState): void {
    const key = conversationKey(conversation.summary.projectId, conversation.summary.id);
    if (!this.#planStates.has(key)) this.#planStates.set(key, state);
  }

  planState(conversation: StoredConversation): PlanSessionState {
    return this.#planStates.get(conversationKey(conversation.summary.projectId, conversation.summary.id)) ?? { mode: "normal" };
  }

  async cancelPlan(project: ProjectState, conversation: StoredConversation): Promise<void> {
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before cancelling the plan");
    await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before cancelling the plan");
    this.#setPlanState(project, conversation, { mode: "normal" });
  }

  async refinePlan(project: ProjectState, conversation: StoredConversation): Promise<void> {
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before refining the plan");
    await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before refining the plan");
    const state = this.planState(conversation);
    if (state.mode !== "awaiting_approval" || !state.plan) throw new Error("There is no plan waiting for refinement");
    this.#setPlanState(project, conversation, { mode: "planning", plan: state.plan });
  }

  async approvePlan(project: ProjectState, conversation: StoredConversation): Promise<{ turnId: string; result: Promise<AgentRunResult> }> {
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before approving the plan");
    await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before approving the plan");
    const state = this.planState(conversation);
    if (state.mode !== "awaiting_approval" || !state.plan) throw new Error("There is no plan waiting for approval");
    const turnId = randomUUID();
    this.#setPlanState(project, conversation, { mode: "executing", plan: state.plan });
    return {
      turnId,
      result: this.#startPrompt(project, conversation, "Execute the approved plan", [], [], turnId, undefined, "executing", state.plan),
    };
  }

  async setModel(
    projectId: string,
    conversationId: string,
    model: RuntimeModel,
    persist: () => void,
  ): Promise<void> {
    const key = conversationKey(projectId, conversationId);
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) throw new Error("Wait for the agent to finish before changing models");
    const managed = this.#sessions.get(key);
    if (!managed) {
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
    const key = conversationKey(projectId, conversationId);
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) throw new Error("Wait for the agent to finish before changing reasoning");
    const managed = this.#sessions.get(key);
    if (!managed) {
      persist();
      return undefined;
    }
    if (!managed.session.setThinkingLevel) {
      throw new Error("The current agent session cannot change reasoning");
    }
    managed.session.setThinkingLevel(level);
    return managed.session.thinkingLevel ?? level;
  }

  async compact(
    project: ProjectState,
    conversation: StoredConversation,
    customInstructions?: string,
  ): Promise<{ turnId: string; result: Promise<AgentRunResult> }> {
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) {
      throw new Error("Wait for the agent to finish before compacting the session");
    }
    const managed = await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) {
      throw new Error("Wait for the agent to finish before compacting the session");
    }
    if (!managed.session.compact) throw new Error("The current agent session cannot compact context");

    const turnId = randomUUID();
    const active: ActiveTurn = {
      project,
      projectId: project.id,
      conversationId: conversation.summary.id,
      turnId,
      prompt: "",
      mentions: [],
      images: [],
      mode: "normal",
      conversation,
      status: "running",
      assistantItemIds: new Map(),
      completedAssistantIndexes: new Set(),
      assistantSequence: 0,
      thinkingSequence: 0,
      preparingToolItemIds: new Map(),
      toolItemIds: new Map(),
      items: new Map(),
    };
    this.#activeTurns.set(key, active);
    this.#setState(project.id, conversation.summary.id, { status: "running" });

    let run: Promise<AgentRunResult>;
    const execution = managed.session.compact(customInstructions).then(() => "completed" as const);
    run = execution.then(
      (result) => {
        this.#finishCompact(project, active, run);
        return result;
      },
      (cause) => {
        this.#finishCompact(project, active, run, cause);
        throw cause;
      },
    );
    this.#runs.add(run);
    void run.catch(() => {});
    return { turnId, result: run };
  }

  async contextUsage(project: ProjectState, conversation: StoredConversation): Promise<AgentContextUsage | undefined> {
    const managed = await this.#getSession(project, conversation);
    return managed.session.getContextUsage?.();
  }

  async skills(project: ProjectState, conversation: StoredConversation): Promise<SkillCatalogItem[]> {
    const existing = this.#sessions.get(conversationKey(project.id, conversation.summary.id));
    if (existing) return existing.session.getSkills?.() ?? [];
    if (this.options.loadSkills) return this.options.loadSkills(project);
    const managed = await this.#getSession(project, conversation);
    return managed.session.getSkills?.() ?? [];
  }

  prompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    references: PromptReference[] = [],
    images: PromptImage[] = [],
    mode: "normal" | "planning" | "executing" = "normal",
    mentions: PluginMention[] = [],
    turnId = randomUUID(),
  ): { turnId: string; queued: boolean; result?: Promise<AgentRunResult | void> } {
    if (!prompt.trim() && images.length === 0) throw new Error("Prompt must not be empty");
    if (this.#closing) throw new Error("Agent manager is closing");
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#revisions.has(key)) throw new Error("A message edit is already starting in this conversation");
    const planState = this.planState(conversation);
    if (mode === "normal" && planState.mode !== "normal") throw new Error("Finish or cancel the current plan before continuing");
    if (mode === "planning" && planState.mode === "executing") throw new Error("The plan is already executing");
    const active = this.#activeTurns.get(key);
    if (active) {
      if (mode !== "normal") throw new Error("Wait for the agent to finish before changing plan mode");
      if (active.status === "cancelling") throw new Error("Wait for the agent to stop");
      const wirePrompt = promptWithReferences(skillInvocationPrompt(serializePluginMentions(prompt, mentions)), references);
      const result = this.#withQueueMutation(key, async () => {
        const event = this.events.publish(
          project.id,
          "prompt.queued",
          { prompt, ...(mentions.length ? { mentions } : {}), references, ...(images.length ? { images } : {}) },
          { conversationId: conversation.summary.id, turnId },
          images.length ? { prompt, references } : undefined,
        );
        const queued = { turnId, prompt, mentions, references, images, wirePrompt, queuedEventId: event.id };
        this.#pendingPrompts.set(key, [...(this.#pendingPrompts.get(key) ?? []), queued]);
        try {
          const managed = await this.#getSession(project, conversation);
          const current = this.#activeTurns.get(key);
          if (!current || current.status !== "running") {
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

    this.#pendingPrompts.delete(key);
    if (mode === "planning") this.#setPlanState(project, conversation, { mode: "planning", ...(planState.plan ? { plan: planState.plan } : {}) }, false);
    return { turnId, queued: false, result: this.#startPrompt(project, conversation, prompt, references, images, turnId, undefined, mode, planState.plan, mentions) };
  }

  async reviseLast(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    validateReference: (reference: PromptReference) => Promise<PromptReference>,
  ): Promise<{ turnId: string; result: Promise<AgentRunResult> }> {
    if (!prompt.trim()) throw new Error("Prompt must not be empty");
    if (this.#closing) throw new Error("Agent manager is closing");
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.planState(conversation).mode !== "normal") throw new Error("Finish or cancel the current plan before editing a message");
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) {
      throw new Error("Wait for the agent to finish before editing a message");
    }
    if ((this.#pendingPrompts.get(key)?.length ?? 0) > 0 || (this.#steeringPrompts.get(key)?.length ?? 0) > 0) {
      throw new Error("Remove queued messages before editing a message");
    }

    this.#revisions.add(key);
    let navigated = false;
    try {
      const previous = lastUserPrompt(project.workspacePath, conversation.sessionPath);
      if (!previous) throw new Error("There is no user message to edit");
      const references = await Promise.all(previous.references.map(validateReference));
      const managed = await this.#getSession(project, conversation);
      if (!managed.session.navigateTree) throw new Error("The current agent session cannot edit messages");
      const navigation = await managed.session.navigateTree(previous.id, { summarize: false });
      if (navigation.cancelled) throw new Error("Message edit was cancelled");
      navigated = true;

      const turnId = randomUUID();
      return {
        turnId,
        result: this.#startPrompt(
          project,
          conversation,
          prompt,
          references,
          previous.images,
          turnId,
          "last-turn",
          "normal",
          undefined,
          previous.mentions.filter((mention) => hasPluginMentionToken(prompt, mention)),
        ),
      };
    } catch (cause) {
      if (navigated && !this.#activeTurns.has(key)) this.#forgetConversation(key);
      throw cause;
    } finally {
      this.#revisions.delete(key);
      this.#flushInvalidatedProject(project.id);
    }
  }

  #startPrompt(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    references: PromptReference[],
    images: PromptImage[],
    turnId: string,
    revision?: "last-turn",
    mode: PlanMode = "normal",
    plan?: PlanState,
    mentions: PluginMention[] = [],
  ): Promise<AgentRunResult> {

    const active: ActiveTurn = {
      project,
      projectId: project.id,
      conversationId: conversation.summary.id,
      turnId,
      prompt,
      mentions,
      images,
      mode,
      conversation,
      plan,
      status: "running",
      assistantItemIds: new Map(),
      completedAssistantIndexes: new Set(),
      assistantSequence: 0,
      thinkingSequence: 0,
      preparingToolItemIds: new Map(),
      toolItemIds: new Map(),
      items: new Map(),
    };
    this.#activeTurns.set(conversationKey(project.id, active.conversationId), active);
    this.#setState(project.id, active.conversationId, { status: "running" });
    const started = this.events.publish(
      project.id,
      "agent.started",
      { prompt, ...(mentions.length ? { mentions } : {}), ...(images.length ? { images } : {}), ...(revision ? { revision } : {}) },
      eventScope(active),
      images.length ? { prompt, ...(revision ? { revision } : {}) } : undefined,
    );
    active.startedEventId = started.id;
    active.startedAt = Date.parse(started.timestamp);
    const mentionedPrompt = serializePluginMentions(prompt, mentions);
    const invocation = mode === "normal" ? skillInvocationPrompt(mentionedPrompt) : mentionedPrompt;
    const wirePrompt = mode === "planning"
      ? planningPrompt(promptWithReferences(invocation, references))
      : mode === "executing"
        ? executionPrompt(promptWithReferences(invocation, references), active.plan)
        : promptWithReferences(invocation, references);
    const execution = this.#runPrompt(project, conversation, wirePrompt, images, active);
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
      if (active.mode === "planning" || active.mode === "executing") {
        appendPlanState(managed.session.sessionManager, {
          mode: active.mode,
          ...(active.plan ? { plan: active.plan } : {}),
        });
      }
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }

      managed.session.setActiveToolsByName?.(this.options.activeToolNames?.(project, active.mode, managed.session) ?? BASE_TOOL_NAMES);
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

      this.#completeOpenItems(project.id, active, "completed");
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
    const key = conversationKey(projectId, conversationId);
    const active = this.#activeTurns.get(key);
    if (!active || active.turnId !== turnId || active.status !== "running") return;
    active.status = "cancelling";
    this.#setState(projectId, conversationId, { status: "cancelling" });
    const managed = this.#sessions.get(key);
    if (managed) {
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
    const key = conversationKey(projectId, conversationId);
    const active = this.#activeTurns.get(key);
    if (!active || active.status !== "running") {
      throw new Error("Agent run is not active");
    }
    const managed = this.#sessions.get(key);
    if (!managed) throw new Error("Agent session is not active");
    if (!managed.session.clearQueue || !managed.session.followUp || !managed.session.steer) {
      throw new Error("The current agent session cannot modify its message queue");
    }
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
    return (this.#pendingPrompts.get(conversationKey(projectId, conversationId)) ?? []).map(({ turnId, prompt, mentions, references, images }) => ({
      turnId, prompt, mentions, references, images,
    }));
  }

  askQuestionnaire(
    projectId: string,
    conversationId: string,
    toolCallId: string,
    input: {
      questions: Array<{
        id: string;
        prompt: string;
        options: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
        allowOther?: boolean;
      }>;
    },
    signal?: AbortSignal,
  ): Promise<QuestionnaireResult> {
    const key = conversationKey(projectId, conversationId);
    const active = this.#activeTurns.get(key);
    if (!active || active.mode !== "planning") throw new Error("Questions can only be asked during an active plan");
    if (this.#questionnaires.has(key)) throw new Error("A questionnaire is already waiting for an answer");
    validateQuestionnaire(input.questions);
    const item: Extract<ThreadItem, { type: "userInputRequest" }> = {
      id: `${active.turnId}:input:${toolCallId}`,
      turnId: active.turnId,
      type: "userInputRequest",
      requestId: toolCallId,
      status: "inProgress",
      questions: input.questions.map((question) => ({
        id: question.id,
        prompt: question.prompt.trim(),
        options: question.options.map((option) => ({
          value: option.value,
          label: option.label.trim(),
          ...(option.description?.trim() ? { description: option.description.trim() } : {}),
          ...(option.recommended ? { recommended: true } : {}),
        })),
        allowOther: question.allowOther !== false,
      })),
    };
    return new Promise<QuestionnaireResult>((resolve, reject) => {
      const pending: PendingQuestionnaire = { item, resolve, reject };
      if (signal) {
        const abort = () => {
          if (this.#questionnaires.get(key) !== pending) return;
          this.#questionnaires.delete(key);
          this.#completeItem(projectId, active, { ...item, status: "cancelled" });
          reject(new Error("Questionnaire cancelled"));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      this.#questionnaires.set(key, pending);
      this.#startItem(projectId, active, item);
    });
  }

  answerQuestionnaire(
    projectId: string,
    conversationId: string,
    requestId: string,
    answers: Array<{ questionId: string; value: string }> = [],
    cancelled = false,
  ): void {
    const key = conversationKey(projectId, conversationId);
    const pending = this.#questionnaires.get(key);
    if (!pending || pending.item.requestId !== requestId) throw new Error("Questionnaire is no longer active");
    const result: QuestionnaireResult = {
      cancelled,
      answers: cancelled ? [] : questionnaireAnswers(pending.item.questions, answers),
    };
    this.#questionnaires.delete(key);
    pending.removeAbortListener?.();
    const active = this.#activeTurns.get(key);
    if (active) this.#completeItem(projectId, active, {
      ...pending.item,
      status: cancelled ? "cancelled" : "completed",
      answers: result.answers,
    });
    pending.resolve(result);
  }

  activeItems(projectId: string, conversationId: string): ThreadItem[] {
    const active = this.#activeTurns.get(conversationKey(projectId, conversationId));
    if (!active) return [];
    return [{
      id: `${active.turnId}:user`,
      turnId: active.turnId,
      type: "userMessage",
      text: active.prompt,
      ...(active.mentions.length ? { mentions: active.mentions } : {}),
      ...(active.images.length ? { images: active.images } : {}),
      ...(active.startedAt === undefined ? {} : { timestamp: active.startedAt }),
    }, ...active.items.values()];
  }

  activeTurnId(projectId: string, conversationId: string): string | undefined {
    return this.#activeTurns.get(conversationKey(projectId, conversationId))?.turnId;
  }

  activeStart(projectId: string, conversationId: string): { id: number; timestamp: string } | undefined {
    const active = this.#activeTurns.get(conversationKey(projectId, conversationId));
    if (!active || active.startedEventId === undefined || active.startedAt === undefined) return undefined;
    return { id: active.startedEventId, timestamp: new Date(active.startedAt).toISOString() };
  }

  eventImages(projectId: string, conversationId: string | undefined, turnId: string | undefined): PromptImage[] | undefined {
    if (!conversationId || !turnId) return undefined;
    const active = this.#activeTurns.get(conversationKey(projectId, conversationId));
    if (active?.turnId === turnId) return active.images;
    const pending = this.#pendingPrompts.get(conversationKey(projectId, conversationId));
    const steering = this.#steeringPrompts.get(conversationKey(projectId, conversationId));
    return [...(pending ?? []), ...(steering ?? [])].find((item) => item.turnId === turnId)?.images;
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const active of this.#activeTurns.values()) {
      active.status = "cancelling";
      this.#setState(active.projectId, active.conversationId, { status: "cancelling" });
    }
    for (const pending of this.#questionnaires.values()) {
      pending.removeAbortListener?.();
      pending.reject(new Error("Agent manager is closing"));
    }
    this.#questionnaires.clear();
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
      if (this.#activeTurns.get(key) !== active) return;
      this.#activeTurns.delete(key);
      const questionnaire = this.#questionnaires.get(key);
      if (questionnaire) {
        questionnaire.removeAbortListener?.();
        this.#completeItem(projectId, active, {
          ...questionnaire.item,
          status: "failed",
          error: itemError("Planning ended before the questionnaire was answered"),
        });
        questionnaire.reject(new Error("Planning ended before the questionnaire was answered"));
        this.#questionnaires.delete(key);
      }
      if (active.images.length && active.startedEventId !== undefined) this.events.expireThrough(projectId, active.startedEventId);
      if ((this.#pendingPrompts.get(key)?.length ?? 0) > 0 || (this.#steeringPrompts.get(key)?.length ?? 0) > 0) {
        this.#sessions.get(key)?.session.clearQueue?.();
      }
      this.#clearPending(projectId, active.conversationId);
      if (active.mode === "planning") {
        this.#setPlanState(project, active.conversation, result === "completed" && active.plan
          ? { mode: "awaiting_approval", plan: active.plan }
          : { mode: "normal" });
      } else if (active.mode === "executing") {
        this.#setPlanState(project, active.conversation, result === "completed"
          ? { mode: "normal" }
          : { mode: "awaiting_approval", ...(active.plan ? { plan: active.plan } : {}) });
      }
      if (result === "completed" && !this.#closing) this.options.onRunCompleted?.(project);
      this.#flushInvalidatedProject(projectId);
    });
  }

  #finishCompact(project: ProjectState, active: ActiveTurn, run: Promise<AgentRunResult>, cause?: unknown): void {
    this.#runs.delete(run);
    const key = conversationKey(project.id, active.conversationId);
    if (this.#activeTurns.get(key) === active) {
      const error = cause === undefined ? undefined : cause instanceof Error ? cause.message : String(cause);
      this.#completeOpenItems(project.id, active, error ? "failed" : "completed", error);
      this.#activeTurns.delete(key);
      this.#setState(project.id, active.conversationId, error ? { status: "error", error } : { status: "idle" });
      this.events.publish(project.id, error ? "agent.error" : "agent.completed", error ? { error } : {}, eventScope(active));
      this.#flushInvalidatedProject(project.id);
    }
  }

  #setPlanState(project: ProjectState, conversation: StoredConversation, state: PlanSessionState, persist = true): void {
    const key = conversationKey(project.id, conversation.summary.id);
    this.#planStates.set(key, state);
    if (persist) appendPlanState(this.#sessions.get(key)?.session.sessionManager, state);
    this.events.publish(project.id, "plan.mode.changed", state, { conversationId: conversation.summary.id });
  }

  async #getSession(project: ProjectState, conversation: StoredConversation): Promise<ManagedSession> {
    const key = conversationKey(project.id, conversation.summary.id);
    const existing = this.#sessions.get(key);
    if (existing) return existing;
    const loading = this.#sessionLoads.get(key);
    if (loading) return loading;
    const promise = this.#loadSession(project, conversation);
    this.#sessionLoads.set(key, promise);
    let managed: ManagedSession;
    try {
      managed = await promise;
    } finally {
      if (this.#sessionLoads.get(key) === promise) this.#sessionLoads.delete(key);
      this.#flushInvalidatedProject(project.id);
    }
    return this.#sessions.get(key) === managed ? managed : this.#getSession(project, conversation);
  }

  async #loadSession(project: ProjectState, conversation: StoredConversation): Promise<ManagedSession> {
    const key = conversationKey(project.id, conversation.summary.id);

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
    const managed = { session, unsubscribe };
    this.#sessions.set(key, managed);
    const entry = session.sessionManager?.getBranch().findLast((candidate) => candidate.type === "custom" && candidate.customType === "ohmygame-plan");
    if (!this.#planStates.has(key) && entry?.type === "custom" && entry.data && typeof entry.data === "object") {
      const state = entry.data as Partial<PlanSessionState>;
      if (state.mode === "normal" || state.mode === "planning" || state.mode === "awaiting_approval" || state.mode === "executing") {
        this.#planStates.set(key, { mode: state.mode, ...(state.plan ? { plan: state.plan } : {}) });
      }
    }
    return managed;
  }

  #forwardEvent(projectId: string, conversationId: string, event: AgentSessionEvent): void {
    const active = this.#activeTurns.get(conversationKey(projectId, conversationId));
    if (!active) return;
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
      active.mentions = started.mentions;
      active.images = started.images;
      active.assistantItemIds.clear();
      active.completedAssistantIndexes.clear();
      active.assistantSequence = 0;
      active.thinkingItemId = undefined;
      active.thinkingSequence = 0;
      active.preparingToolItemIds.clear();
      active.toolItemIds.clear();
      active.retryItemId = undefined;
      active.items.clear();
      this.#setState(projectId, conversationId, { status: "running" });
      const startedEvent = this.events.publish(
        projectId,
        "agent.started",
        { prompt: started.prompt, ...(started.mentions.length ? { mentions: started.mentions } : {}), ...(started.images.length ? { images: started.images } : {}) },
        eventScope(active),
        started.images.length ? { prompt: started.prompt } : undefined,
      );
      active.startedEventId = startedEvent.id;
      active.startedAt = Date.parse(startedEvent.timestamp);
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
      const itemId = `${active.turnId}:assistant:${active.assistantSequence++}`;
      active.assistantItemIds.set(event.assistantMessageEvent.contentIndex, itemId);
      active.completedAssistantIndexes.delete(event.assistantMessageEvent.contentIndex);
      this.#startItem(projectId, active, {
        id: itemId,
        turnId: active.turnId,
        type: "agentMessage",
        text: "",
        status: "inProgress",
      });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") {
      active.thinkingItemId = `${active.turnId}:thinking:${active.thinkingSequence++}`;
      this.#startItem(projectId, active, {
        id: active.thinkingItemId,
        turnId: active.turnId,
        type: "reasoning",
        text: "",
        status: "inProgress",
      });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
      const itemId = active.thinkingItemId ?? `${active.turnId}:thinking:${active.thinkingSequence++}`;
      if (!active.thinkingItemId) {
        active.thinkingItemId = itemId;
        this.#startItem(projectId, active, {
          id: itemId,
          turnId: active.turnId,
          type: "reasoning",
          text: "",
          status: "inProgress",
        });
      }
      this.#appendItemText(active, itemId, event.assistantMessageEvent.delta);
      this.events.publish(projectId, "item.reasoning.textDelta", { itemId, delta: event.assistantMessageEvent.delta }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end") {
      if (active.thinkingItemId) {
        const item = active.items.get(active.thinkingItemId);
        if (item?.type === "reasoning") {
          this.#completeItem(projectId, active, { ...item, text: event.assistantMessageEvent.content, status: "completed" });
        }
        active.thinkingItemId = undefined;
      }
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const itemId = active.assistantItemIds.get(contentIndex) ?? `${active.turnId}:assistant:${active.assistantSequence++}`;
      if (!active.assistantItemIds.has(contentIndex)) {
        active.assistantItemIds.set(contentIndex, itemId);
        this.#startItem(projectId, active, {
          id: itemId,
          turnId: active.turnId,
          type: "agentMessage",
          text: "",
          status: "inProgress",
        });
      }
      this.#appendItemText(active, itemId, event.assistantMessageEvent.delta);
      this.events.publish(projectId, "item.agentMessage.delta", { itemId, delta: event.assistantMessageEvent.delta }, eventScope(active));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const itemId = active.assistantItemIds.get(contentIndex);
      if (itemId) {
        const phase = assistantBlockPhase(event.assistantMessageEvent.partial.content[contentIndex]);
        const item = active.items.get(itemId);
        if (phase && item?.type === "agentMessage") {
          this.#completeItem(projectId, active, {
            ...item,
            text: event.assistantMessageEvent.content,
            status: "completed",
            phase,
          });
          active.completedAssistantIndexes.add(contentIndex);
        }
      }
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const toolCall = partialToolCall(event.assistantMessageEvent.partial, contentIndex);
      if (!toolCall?.name || toolCall.name === "update_plan" || toolCall.name === "questionnaire") return;
      const itemId = `${active.turnId}:tool:${active.assistantSequence++}`;
      const toolCallId = toolCall.id || `${active.turnId}:preparing:${contentIndex}`;
      active.preparingToolItemIds.set(contentIndex, itemId);
      if (toolCall.id) active.toolItemIds.set(toolCall.id, itemId);
      this.#startItem(projectId, active, toolThreadItem(active.turnId, itemId, toolCallId, toolCall.name, undefined, "preparing"));
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
      const { contentIndex, toolCall } = event.assistantMessageEvent;
      if (toolCall.name === "questionnaire") {
        active.preparingToolItemIds.delete(contentIndex);
        return;
      }
      if (toolCall.name === "update_plan") {
        active.preparingToolItemIds.delete(contentIndex);
        return;
      }
      const itemId = active.preparingToolItemIds.get(contentIndex) ?? `${active.turnId}:tool:${active.assistantSequence++}`;
      active.preparingToolItemIds.delete(contentIndex);
      active.toolItemIds.set(toolCall.id, itemId);
      const args = toolArguments(toolCall.name, toolCall.arguments);
      this.#updateItem(projectId, active, toolThreadItem(active.turnId, itemId, toolCall.id, toolCall.name, args, "preparing"));
    } else if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const status = threadItemStatus(event.message.stopReason);
      for (const [contentIndex, itemId] of active.assistantItemIds) {
        if (status === "completed" && active.completedAssistantIndexes.has(contentIndex)) continue;
        const phase = assistantMessagePhase(
          Array.isArray(event.message.content) ? event.message.content[contentIndex] : undefined,
          event.message.stopReason,
        );
        const item = active.items.get(itemId);
        if (item?.type !== "agentMessage") continue;
        this.#completeItem(projectId, active, {
          ...item,
          status,
          ...(phase ? { phase } : {}),
          ...(event.message.stopReason === "error" ? { error: itemError(event.message.errorMessage || "The model request failed") } : {}),
        });
      }
      if (active.assistantItemIds.size === 0 && status !== "completed") {
        const itemId = `${active.turnId}:assistant:${active.assistantSequence++}`;
        const item: Extract<ThreadItem, { type: "agentMessage" }> = {
          id: itemId,
          turnId: active.turnId,
          type: "agentMessage",
          text: "",
          status,
          ...(event.message.stopReason === "error" ? { error: itemError(event.message.errorMessage || "The model request failed") } : {}),
        };
        this.#startItem(projectId, active, { ...item, status: "inProgress" });
        this.#completeItem(projectId, active, item);
      }
      active.assistantItemIds.clear();
      active.completedAssistantIndexes.clear();
      active.preparingToolItemIds.clear();
    } else if (event.type === "auto_retry_start") {
      const item: Extract<ThreadItem, { type: "retry" }> = {
        id: `${active.turnId}:retry`,
        turnId: active.turnId,
        type: "retry",
        status: "inProgress",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: itemError(event.errorMessage),
      };
      active.retryItemId = item.id;
      this.#updateItem(projectId, active, item);
    } else if (event.type === "auto_retry_end") {
      const item = active.retryItemId ? active.items.get(active.retryItemId) : undefined;
      if (item?.type === "retry") {
        this.#completeItem(projectId, active, {
          ...item,
          status: event.success ? "completed" : "failed",
          ...(event.finalError ? { error: itemError(event.finalError) } : {}),
        });
        if (event.success) active.items.delete(item.id);
      }
      active.retryItemId = undefined;
    } else if (event.type === "compaction_start") {
      this.#startItem(projectId, active, {
        id: `${active.turnId}:compaction`,
        turnId: active.turnId,
        type: "contextCompaction",
        status: "inProgress",
      });
    } else if (event.type === "compaction_end") {
      this.#completeItem(projectId, active, {
        id: `${active.turnId}:compaction`,
        turnId: active.turnId,
        type: "contextCompaction",
        status: event.aborted ? "failed" : "completed",
        ...(event.errorMessage ? { error: itemError(event.errorMessage) } : event.aborted ? {
          error: itemError(event.willRetry ? "Context compaction interrupted; retrying" : "Context compaction interrupted"),
        } : {}),
      });
    } else if (event.type === "tool_execution_start") {
      if (event.toolName === "update_plan" || event.toolName === "questionnaire") return;
      const itemId = active.toolItemIds.get(event.toolCallId) ?? `${active.turnId}:tool:${event.toolCallId}`;
      active.toolItemIds.set(event.toolCallId, itemId);
      const args = toolArguments(event.toolName, event.args);
      this.#updateItem(projectId, active, toolThreadItem(active.turnId, itemId, event.toolCallId, event.toolName, args, "inProgress"));
    } else if (event.type === "tool_execution_update") {
      if (event.toolName === "update_plan" || event.toolName === "questionnaire") return;
      const result = toolOutput(event.partialResult);
      const itemId = active.toolItemIds.get(event.toolCallId) ?? `${active.turnId}:tool:${event.toolCallId}`;
      const item = active.items.get(itemId);
      if (item?.type === "dynamicToolCall" || item?.type === "mcpToolCall") {
        this.#updateItem(projectId, active, { ...item, ...result });
      }
    } else if (event.type === "tool_execution_end") {
      if (event.toolName === "questionnaire") return;
      if (event.toolName === "update_plan") {
        const plan = toolPlan(event.result);
        if (!event.isError && plan) {
          active.plan = plan;
          if (active.mode === "planning" || active.mode === "executing") {
            this.#setPlanState(active.project, active.conversation, { mode: active.mode, plan });
          }
          const item: ThreadItem = {
            id: `${active.turnId}:plan`,
            turnId: active.turnId,
            type: "plan",
            plan,
          };
          this.#updateItem(projectId, active, item);
          this.#completeItem(projectId, active, item);
        }
        return;
      }
      const result = toolOutput(event.result);
      const itemId = active.toolItemIds.get(event.toolCallId) ?? `${active.turnId}:tool:${event.toolCallId}`;
      const current = active.items.get(itemId);
      const item = current?.type === "dynamicToolCall" || current?.type === "mcpToolCall"
        ? current
        : toolThreadItem(active.turnId, itemId, event.toolCallId, event.toolName, undefined, "inProgress");
      this.#completeItem(projectId, active, {
        ...item,
        status: event.isError ? "failed" : "completed",
        ...result,
      });
    }
  }

  #startItem(projectId: string, active: ActiveTurn, item: ThreadItem): void {
    active.items.set(item.id, item);
    this.events.publish(projectId, "item.started", { item }, eventScope(active));
  }

  #updateItem(projectId: string, active: ActiveTurn, item: ThreadItem): void {
    const type = active.items.has(item.id) ? "item.updated" : "item.started";
    active.items.set(item.id, item);
    this.events.publish(projectId, type, { item }, eventScope(active));
  }

  #completeItem(projectId: string, active: ActiveTurn, item: ThreadItem): void {
    active.items.set(item.id, item);
    this.events.publish(projectId, "item.completed", { item }, eventScope(active));
  }

  #appendItemText(active: ActiveTurn, itemId: string, delta: string): void {
    const item = active.items.get(itemId);
    if (item?.type === "agentMessage" || item?.type === "reasoning") {
      active.items.set(itemId, { ...item, text: item.text + delta });
    }
  }

  #completeOpenItems(projectId: string, active: ActiveTurn, status: "completed" | "cancelled" | "failed", error?: string): void {
    for (const item of active.items.values()) {
      if (item.type === "agentMessage" && item.status === "inProgress") {
        this.#completeItem(projectId, active, { ...item, status, ...(status === "failed" && error ? { error: itemError(error) } : {}) });
      } else if (item.type === "reasoning" && item.status === "inProgress") {
        this.#completeItem(projectId, active, { ...item, status: "completed" });
      } else if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") &&
        (item.status === "preparing" || item.status === "inProgress")) {
        this.#completeItem(projectId, active, { ...item, status: "failed" });
      } else if (item.type === "contextCompaction" && item.status === "inProgress") {
        this.#completeItem(projectId, active, {
          ...item,
          status: status === "completed" ? "completed" : "failed",
          ...(error ? { error: itemError(error) } : {}),
        });
      } else if (item.type === "retry" && item.status === "inProgress") {
        this.#completeItem(projectId, active, {
          ...item,
          status: status === "completed" ? "completed" : "failed",
          ...(error ? { error: itemError(error) } : {}),
        });
      } else if (item.type === "userInputRequest" && item.status === "inProgress") {
        this.#completeItem(projectId, active, {
          ...item,
          status: status === "cancelled" ? "cancelled" : "failed",
          ...(error ? { error: itemError(error) } : {}),
        });
      }
    }
  }

  #ensureTerminalAgentItem(projectId: string, active: ActiveTurn, status: "cancelled" | "failed", error?: string): void {
    if ([...active.items.values()].some((item) => item.type === "agentMessage" && item.status === status)) return;
    const item: Extract<ThreadItem, { type: "agentMessage" }> = {
      id: `${active.turnId}:status`,
      turnId: active.turnId,
      type: "agentMessage",
      text: "",
      status,
      ...(error ? { error: itemError(error) } : {}),
    };
    this.#startItem(projectId, active, { ...item, status: "inProgress" });
    this.#completeItem(projectId, active, item);
  }

  #markCancelled(projectId: string, active: ActiveTurn): void {
    this.#completeOpenItems(projectId, active, "cancelled");
    this.#ensureTerminalAgentItem(projectId, active, "cancelled");
    this.#setState(projectId, active.conversationId, { status: "idle" });
    this.events.publish(projectId, "agent.cancelled", {}, eventScope(active));
  }

  #markError(projectId: string, active: ActiveTurn, error: string): void {
    this.#completeOpenItems(projectId, active, "failed", error);
    this.#ensureTerminalAgentItem(projectId, active, "failed", error);
    this.#setState(projectId, active.conversationId, { status: "error", error });
    this.events.publish(projectId, "agent.error", { error }, eventScope(active));
  }

  #setState(projectId: string, conversationId: string, state: ConversationAgentState): void {
    this.#agentStates.set(conversationKey(projectId, conversationId), state);
  }

  isProjectBusy(projectId: string): boolean {
    const prefix = `${projectId}:`;
    return [...this.#activeTurns.keys(), ...this.#revisions].some((key) => key.startsWith(prefix));
  }

  invalidateProjectSessions(projectId: string): void {
    this.#invalidatedProjects.add(projectId);
    this.#flushInvalidatedProject(projectId);
  }

  forgetProject(projectId: string): void {
    this.#invalidatedProjects.delete(projectId);
    const prefix = `${projectId}:`;
    for (const key of this.#sessions.keys()) {
      if (key.startsWith(prefix)) this.#forgetConversation(key);
    }
    for (const key of this.#agentStates.keys()) {
      if (key.startsWith(prefix)) this.#agentStates.delete(key);
    }
    for (const key of this.#planStates.keys()) {
      if (key.startsWith(prefix)) this.#planStates.delete(key);
    }
  }

  #flushInvalidatedProject(projectId: string): void {
    const prefix = `${projectId}:`;
    if (!this.#invalidatedProjects.has(projectId) || this.isProjectBusy(projectId) || [...this.#sessionLoads.keys()].some((key) => key.startsWith(prefix))) return;
    this.#invalidatedProjects.delete(projectId);
    for (const key of this.#sessions.keys()) {
      if (key.startsWith(prefix)) this.#forgetConversation(key);
    }
  }

  #forgetConversation(key: string): void {
    const managed = this.#sessions.get(key);
    if (!managed) return;
    managed.unsubscribe();
    managed.session.dispose();
    this.#sessions.delete(key);
  }
}

const REFERENCE_MARKER = "<workspace-file-references>";

function promptWithReferences(prompt: string, references: PromptReference[]): string {
  if (references.length === 0) return prompt;
  return `${prompt}\n\n${REFERENCE_MARKER}\n${JSON.stringify(references.map(({ path }) => path))}\n</workspace-file-references>`;
}

export function skillInvocationPrompt(prompt: string): string {
  const match = prompt.match(/^\$([a-zA-Z0-9][a-zA-Z0-9._-]*)(?=\s|$)/);
  return match ? `/skill:${match[1]}${prompt.slice(match[0].length)}` : prompt;
}

function parseUserPrompt(value: string): { text: string; mentions: PluginMention[]; references: PromptReference[] } {
  const marker = `\n\n${REFERENCE_MARKER}\n`;
  const index = value.lastIndexOf(marker);
  const visible = index < 0 ? value : value.slice(0, index);
  const skill = parseSkillBlock(visible);
  const restored = skill ? `$${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}` : visible;
  const parsed = parsePluginMentions(restored);
  const text = parsed.text;
  if (index < 0) return { text, mentions: parsed.mentions, references: [] };
  const closing = "\n</workspace-file-references>";
  const encoded = value.slice(index + marker.length, value.endsWith(closing) ? -closing.length : undefined);
  try {
    const paths: unknown = JSON.parse(encoded);
    return {
      text,
      mentions: parsed.mentions,
      references: Array.isArray(paths)
        ? paths.filter((item): item is string => typeof item === "string").map((path) => ({ type: "workspace-file", path }))
        : [],
    };
  } catch {
    return { text, mentions: parsed.mentions, references: [] };
  }
}

function lastUserPrompt(workspacePath: string, sessionPath: string): {
  id: string;
  mentions: PluginMention[];
  references: PromptReference[];
  images: PromptImage[];
} | undefined {
  const sessionDirectory = path.join(path.dirname(workspacePath), "session");
  const entries = SessionManager.open(sessionPath, sessionDirectory, workspacePath).getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const parsed = parseUserPrompt(textContent(entry.message.content));
    return {
      id: entry.id,
      mentions: parsed.mentions,
      references: parsed.references,
      images: imageContent(entry.message.content),
    };
  }
  return undefined;
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

function assistantMessagePhase(content: unknown, stopReason: string): AgentMessagePhase | undefined {
  const explicit = assistantBlockPhase(content);
  if (explicit) return explicit;
  if (stopReason === "toolUse") return "commentary";
  return stopReason === "stop" || stopReason === "length" ? "final_answer" : undefined;
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

function threadItemStatus(stopReason: string): "completed" | "cancelled" | "failed" {
  if (stopReason === "error") return "failed";
  if (stopReason === "aborted") return "cancelled";
  return "completed";
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
    case "mcp": return mcpToolArguments(values);
    default: return boundedValue(args);
  }
}

function toolThreadItem(
  turnId: string,
  itemId: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
  status: "preparing" | "inProgress",
): Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }> {
  const mcp = parseMcpToolIdentity(toolName, args);
  return mcp ? {
    id: itemId,
    turnId,
    type: "mcpToolCall",
    toolCallId,
    server: mcp.server,
    tool: mcp.tool,
    status,
    arguments: mcpToolInput(args),
  } : {
    id: itemId,
    turnId,
    type: "dynamicToolCall",
    toolCallId,
    tool: toolName,
    status,
    arguments: args,
  };
}

function mcpToolArguments(values: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.fromEntries(
    ["server", "tool", "connect", "describe", "instructions", "search", "action"]
      .filter((key) => typeof values[key] === "string")
      .map((key) => [key, (values[key] as string).slice(0, 300)]),
  );
  if (values.args !== undefined) result.args = boundedValue(values.args, 1_000);
  return result;
}

function compactRecord(values: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const result = Object.fromEntries(keys.filter((key) => values[key] !== undefined).map((key) => [key, values[key]]));
  return Object.keys(result).length > 0 ? result : undefined;
}

function boundedValue(value: unknown, maxLength = MAX_GENERIC_TOOL_ARGUMENTS): unknown {
  if (value === undefined) return undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return String(value).slice(0, maxLength);
  }
  if (serialized === undefined) return String(value).slice(0, maxLength);
  if (serialized.length <= maxLength) return JSON.parse(serialized) as unknown;
  return `${serialized.slice(0, maxLength)}\n... arguments truncated ...`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolOutput(result: unknown): { output?: string; truncated?: boolean; artifact?: ToolArtifact } {
  const artifact = toolArtifact(result);
  const value = result && typeof result === "object" && "content" in result
    ? textContent((result as { content?: unknown }).content)
    : stringify(result);
  if (!value) return artifact ? { artifact } : {};
  if (value.length <= MAX_TOOL_OUTPUT) return { output: value, ...(artifact ? { artifact } : {}) };
  const half = MAX_TOOL_OUTPUT / 2;
  return {
    output: `${value.slice(0, half)}\n\n... output truncated ...\n\n${value.slice(-half)}`,
    truncated: true,
    ...(artifact ? { artifact } : {}),
  };
}

function toolArtifact(result: unknown): ToolArtifact | undefined {
  const details = result && typeof result === "object" && "details" in result ? (result as { details?: unknown }).details : undefined;
  const artifact = details && typeof details === "object" && "artifact" in details ? (details as { artifact?: unknown }).artifact : undefined;
  if (!artifact || typeof artifact !== "object") return undefined;
  const value = artifact as Partial<ToolArtifact>;
  if (typeof value.path !== "string" || !value.path) return undefined;
  if (value.type === "image" && (value.mediaType === "image/png" || value.mediaType === "image/jpeg" || value.mediaType === "image/webp")) {
    return { type: "image", path: value.path, mediaType: value.mediaType };
  }
  if (value.type === "model" && value.mediaType === "model/gltf-binary") {
    return { type: "model", path: value.path, mediaType: value.mediaType };
  }
  if (value.type === "video" && (value.mediaType === "video/mp4" || value.mediaType === "video/webm")) {
    return { type: "video", path: value.path, mediaType: value.mediaType };
  }
  return undefined;
}

function toolPlan(result: unknown): PlanState | undefined {
  const details = result && typeof result === "object" && "details" in result ? (result as { details?: unknown }).details : undefined;
  const value = details && typeof details === "object" && "plan" in details ? (details as { plan?: unknown }).plan : undefined;
  if (!value || typeof value !== "object" || !Array.isArray((value as { steps?: unknown }).steps)) return undefined;
  const candidate = value as { explanation?: unknown; steps: unknown[] };
  const steps: PlanState["steps"] = candidate.steps.flatMap((step) => {
    if (!step || typeof step !== "object") return [];
    const item = step as { step?: unknown; status?: unknown };
    if (typeof item.step !== "string" || !item.step.trim()) return [];
    const status = item.status;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return [];
    return [{ step: item.step, status }];
  });
  if (steps.length !== candidate.steps.length || steps.length === 0) return undefined;
  return {
    ...(typeof candidate.explanation === "string" && candidate.explanation ? { explanation: candidate.explanation } : {}),
    steps,
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

function planningPrompt(prompt: string): string {
  return `[PLAN MODE]
Explore the project and produce a concrete implementation plan. You may only read files and update the structured plan.
Ask up to three concise questions with questionnaire only when a high-impact choice cannot be resolved from the project or user request.
Plan steps must describe implementation work only. Do not add approval, confirmation, or waiting for the user as a plan step.
Do not modify files, run commands, or begin implementation. End after the plan is ready for user approval.

${prompt}`;
}

function validateQuestionnaire(questions: Array<{
  id: string;
  prompt: string;
  options: Array<{ value: string; label: string; recommended?: boolean }>;
}>): void {
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    throw new Error("Question identifiers must be unique");
  }
  for (const question of questions) {
    if (!question.id.trim() || !question.prompt.trim()) throw new Error("Questions must have an id and prompt");
    if (new Set(question.options.map((option) => option.value)).size !== question.options.length) {
      throw new Error("Question option values must be unique");
    }
    if (question.options.filter((option) => option.recommended).length > 1) {
      throw new Error("A question can have at most one recommended option");
    }
  }
}

function questionnaireAnswers(
  questions: QuestionnaireQuestion[],
  answers: Array<{ questionId: string; value: string }>,
): QuestionnaireAnswer[] {
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer.value.trim()]));
  if (byQuestion.size !== questions.length || answers.length !== questions.length) {
    throw new Error("Every question requires one answer");
  }
  return questions.map((question) => {
    const value = byQuestion.get(question.id);
    if (!value) throw new Error("Question answers cannot be blank");
    const option = question.options.find((candidate) => candidate.value === value);
    if (!option && !question.allowOther) throw new Error("Custom answers are not allowed for this question");
    return {
      questionId: question.id,
      value,
      label: option?.label ?? value,
      custom: !option,
    };
  });
}

function itemError(message: string, code?: string): ThreadItemError {
  return { message, ...(code ? { code } : {}) };
}

function questionnaireThreadItem(
  turnId: string,
  toolCallId: string,
  input: unknown,
  timestamp?: number,
): Extract<ThreadItem, { type: "userInputRequest" }> | undefined {
  const questions = record(input)?.questions;
  if (!Array.isArray(questions)) return undefined;
  const parsed = questions.flatMap((value): QuestionnaireQuestion[] => {
    const question = record(value);
    if (typeof question?.id !== "string" || typeof question.prompt !== "string" || !Array.isArray(question.options)) return [];
    const options = question.options.flatMap((value) => {
      const option = record(value);
      if (typeof option?.value !== "string" || typeof option.label !== "string") return [];
      return [{
        value: option.value,
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
        ...(option.recommended === true ? { recommended: true } : {}),
      }];
    });
    if (options.length !== question.options.length) return [];
    return [{ id: question.id, prompt: question.prompt, options, allowOther: question.allowOther !== false }];
  });
  if (parsed.length !== questions.length) return undefined;
  return {
    id: `${turnId}:input:${toolCallId}`,
    turnId,
    type: "userInputRequest",
    requestId: toolCallId,
    questions: parsed,
    status: "inProgress",
    timestamp,
  };
}

function questionnaireResult(message: unknown): QuestionnaireResult | undefined {
  const details = record(record(message)?.details);
  if (!details || typeof details.cancelled !== "boolean" || !Array.isArray(details.answers)) return undefined;
  const answers = details.answers.flatMap((value): QuestionnaireAnswer[] => {
    const answer = record(value);
    if (typeof answer?.questionId !== "string" || typeof answer.value !== "string" || typeof answer.label !== "string" || typeof answer.custom !== "boolean") return [];
    return [{ questionId: answer.questionId, value: answer.value, label: answer.label, custom: answer.custom }];
  });
  if (answers.length !== details.answers.length) return undefined;
  return { cancelled: details.cancelled, answers };
}

function executionPrompt(prompt: string, plan?: PlanState): string {
  const steps = plan?.steps.map((item, index) => `${index + 1}. [${item.status}] ${item.step}`).join("\n") ?? "";
  return `${prompt}\n\nApproved plan:\n${steps}\n\nExecute the plan and keep update_plan current as steps complete.`;
}

function appendPlanState(sessionManager: CodingSession["sessionManager"], state: PlanSessionState): void {
  if (!sessionManager) return;
  const previous = sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === "ohmygame-plan");
  if (previous?.type === "custom" && JSON.stringify(previous.data) === JSON.stringify(state)) return;
  sessionManager.appendCustomEntry("ohmygame-plan", state);
}

const BASE_TOOL_NAMES = ["read", "write", "edit", "bash"];

export async function createPiSession(
  workspacePath: string,
  sessionManager: SessionManager,
  customTools: ToolDefinition[] = [],
  modelRuntime?: ModelRuntime,
  model?: RuntimeModel,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.resolve(process.cwd(), ".data", "pi-agent"),
  resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>,
): Promise<CodingSession> {
  // Trusted-local phase: cwd guides Pi but is not an OS security boundary.
  const { resourceLoader, sessionSettings, pluginSkills } = await createPiResourceLoader(workspacePath, agentDir, resolvePluginSkills);
  const { session } = await createAgentSession({
    cwd: workspacePath,
    agentDir,
    customTools,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager: sessionSettings,
  });
  await session.bindExtensions({ mode: "rpc" });
  return Object.assign(session, {
    getSkills: () => skillCatalog(resourceLoader.getSkills().skills, pluginSkills),
  });
}

export async function loadPiSkills(
  workspacePath: string,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.resolve(process.cwd(), ".data", "pi-agent"),
  resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>,
): Promise<SkillCatalogItem[]> {
  const { resourceLoader, pluginSkills } = await createPiResourceLoader(workspacePath, agentDir, resolvePluginSkills);
  return skillCatalog(resourceLoader.getSkills().skills, pluginSkills);
}

export async function loadPiSkillCatalog(
  workspacePath: string,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.resolve(process.cwd(), ".data", "pi-agent"),
  resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>,
): Promise<SkillCatalogItem[]> {
  await ensureOhMyGamePiEnvironment(agentDir);
  const pluginSkills = await resolvePluginSkills?.() ?? [];
  return skillCatalog(loadSkills({
    cwd: workspacePath,
    agentDir,
    skillPaths: pluginSkills.map((skill) => skill.path),
    includeDefaults: true,
  }).skills, pluginSkills);
}

async function createPiResourceLoader(
  workspacePath: string,
  agentDir: string,
  resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>,
): Promise<{ resourceLoader: DefaultResourceLoader; sessionSettings: SettingsManager; pluginSkills: PluginSkillRegistration[] }> {
  await ensureOhMyGamePiEnvironment(agentDir);
  const persistedSettings = SettingsManager.create(workspacePath, agentDir);
  const sessionSettings = SettingsManager.inMemory(persistedSettings.getGlobalSettings());
  sessionSettings.applyOverrides(persistedSettings.getProjectSettings());
  sessionSettings.setPackages(withRequiredPiPackages(sessionSettings.getPackages()));
  const pluginSkills = await resolvePluginSkills?.() ?? [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager: sessionSettings,
    additionalSkillPaths: pluginSkills.map((skill) => skill.path),
    appendSystemPrompt: [
      "This workspace may be empty. Do not create files for casual conversation or questions that do not require code. " +
      "When the user asks you to build a game or web app in this workspace, create it as a complete Vite-based browser project whose package.json has non-empty scripts.dev and scripts.build commands, with the build producing a static dist/index.html. " +
      "Do not leave a long-running development server active; the host starts the preview after your turn. " +
      "Make every game responsive inside an iframe of any size, with no fixed-width layout or horizontal overflow.",
      "For tasks that require several tool calls, send a brief commentary update before the first tool call and whenever you discover something important or begin a new major step. " +
      "Keep commentary concise, do not narrate routine tool calls, and reserve the final answer for the completed result.",
      "For multi-step tasks, use update_plan to maintain a concise plan with at most one in_progress step. " +
      "Update it when a meaningful step starts or completes. Do not use update_plan for simple one-step requests.",
    ],
  });
  await resourceLoader.reload();
  return { resourceLoader, sessionSettings, pluginSkills };
}

function skillCatalog(
  skills: Array<{ name: string; description: string; filePath: string }>,
  pluginSkills: readonly PluginSkillRegistration[],
): SkillCatalogItem[] {
  const sources = new Map(pluginSkills.map((skill) => [path.resolve(skill.path), skill]));
  return skills.map(({ name, description, filePath }) => {
    const source = sources.get(path.resolve(filePath));
    return {
      name,
      description,
      ...(source ? {
        pluginDisplayName: source.pluginDisplayName,
        marketplaceDisplayName: source.marketplaceDisplayName,
      } : {}),
    };
  });
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
