import {
  createAgentSession,
  createBashToolDefinition,
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
import { promptContextLabels, splitPromptContext, withProjectDesignContext } from "./prompt-context.js";
import { gameDesignMetadata } from "./game-design-context.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createTrackedWriteTool, fileChangeMetadata } from "./file-line-changes.js";
import { readWorkspaceNotice } from "./workspace-notice.js";
import type { AgentContextUsage, AgentMessagePhase, AgentReasoningLevel, AgentStatus, ConversationAgentState, ConversationAttachment, PendingPrompt, PlanMode, PlanSessionState, PlanState, PluginMention, ProjectAgentActivity, ProjectState, PromptImage, PromptReference, QuestionnaireAnswer, QuestionnaireQuestion, QuestionnaireResult, ResponsesTransportMode, ThreadItem, ThreadItemError, ToolArtifact, TurnChanges } from "../shared/contracts.js";
import { hasPluginMentionToken, parsePluginMentions, serializePluginMentions } from "../shared/plugins.js";
import type { RuntimeEventBus } from "../shared/events.js";
import type { StoredConversation } from "./conversations.js";
import {
  ensureOhMyGamePiEnvironment,
  withoutOhMyGameManagedPiPackages,
} from "./pi-agent.js";
import { mcpToolInput, parseMcpToolIdentity } from "../shared/mcp.js";
import type { PluginSkillRegistration } from "./plugin-runtime.js";
import { appendSystemPromptForProject, type AgentPromptProject } from "./agent-prompts.js";
import { openRouterAttributionExtension } from "./openrouter-attribution.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PluginMcpHost } from "./plugin-mcp-host.js";
import { projectProcessEnvironment } from "./project-process.js";
import { createProviderImageReadTool, installDeepSeekImageFiles } from "./deepseek-image-files.js";
import { SessionImages } from "./session-images.js";
import { installSessionImageRequests } from "./session-image-requests.js";
import { AGENT_ERROR_ENTRY, assistantMessageError, normalizeAgentError, thrownAgentError } from "./agent-errors.js";
import {
  CHECKPOINT_ENTRY, CHECKPOINT_RESTORED_ENTRY, CHECKPOINT_UNDONE_ENTRY, TURN_END_ENTRY, checkpointExtension, parseStoredCheckpoint, parseStoredCheckpointUndone, parseStoredTurnEnd, turnRange,
  type StoredCheckpointUndone, type StoredTurnEnd, type TurnRange,
} from "./checkpoint-extension.js";
import { normalizeAssistantMessage, normalizeAssistantText, AssistantTextStreamNormalizer } from "./assistant-thinking.js";

export interface CodingSession {
  readonly messages: readonly unknown[];
  readonly model?: RuntimeModel;
  /** Whether prompt() emits message_start for its initial user message. */
  readonly emitsInitialUserMessage?: boolean;
  readonly sessionManager?: Pick<SessionManager, "appendCustomEntry" | "getBranch"> & Partial<Pick<SessionManager, "branch">>;
  prompt(prompt: string, options?: { images?: PiPromptImage[] }): Promise<void>;
  followUp?(prompt: string, images?: PiPromptImage[]): Promise<unknown>;
  steer?(prompt: string, images?: PiPromptImage[]): Promise<unknown>;
  compact?(customInstructions?: string): Promise<unknown>;
  abortCompaction?(): void;
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

/** The conversation has no such checkpoint on its current branch. */
export class CheckpointNotFoundError extends Error {
  constructor() {
    super("Checkpoint not found");
  }
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

/**
 * Some OpenAI-compatible endpoints advertise a GPT-5.6 model while rejecting
 * the optional Responses API `prompt_cache_options` field. Keep prompt-cache
 * keys available, but avoid that provider-specific opt-in until compatibility
 * can be established by the endpoint.
 */
export function compatibleRuntimeModel(model: RuntimeModel): RuntimeModel {
  const compat = model.compat as (RuntimeModel["compat"] & { supportsExplicitPromptCacheMode?: boolean }) | undefined;
  if (model.api !== "openai-responses" || !compat?.supportsExplicitPromptCacheMode) return model;
  return {
    ...model,
    compat: {
      ...model.compat,
      supportsExplicitPromptCacheMode: false,
    },
  };
}

export type AgentRunResult = "completed" | "cancelled";
type CompactRunOutcome = { status: AgentRunResult } | { status: "failed"; cause: unknown };
export type SessionFactory = (project: ProjectState, conversation: StoredConversation) => Promise<CodingSession>;

export function conversationItems(entries: readonly SessionEntry[], markInterrupted = true): ThreadItem[] {
  const items: ThreadItem[] = [];
  const tools = new Map<string, Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>>();
  const planCalls = new Set<string>();
  const questionnaireCalls = new Map<string, Extract<ThreadItem, { type: "userInputRequest" }>>();
  let turnId: string | undefined;
  let turnFinished = true;
  let lastTimestamp: number | undefined;
  let storedPrompt: StoredPromptDetails | undefined;
  let checkpointId: string | undefined;

  for (const entry of entries) {
    if (entry.type === "compaction") {
      const compactedAt = Date.parse(entry.timestamp);
      items.push({
        id: entry.id,
        turnId: turnId ?? entry.id,
        type: "contextCompaction",
        status: "completed",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        ...(Number.isFinite(compactedAt) ? { timestamp: compactedAt } : {}),
      });
      continue;
    }
    if (entry.type === "model_change") {
      if (turnId) {
        const modelChangedAt = Date.parse(entry.timestamp);
        items.push({
          id: entry.id,
          turnId: entry.id,
          type: "modelChange",
          model: { provider: entry.provider, id: entry.modelId },
          ...(Number.isFinite(modelChangedAt) ? { timestamp: modelChangedAt } : {}),
        });
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType === USER_PROMPT_ENTRY) {
      storedPrompt = parseStoredPromptDetails(entry.data);
      continue;
    }
    if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY) {
      // The snapshot was taken just before the user message that follows.
      checkpointId = parseStoredCheckpoint(entry.data) ? entry.id : undefined;
      continue;
    }
    if (entry.type === "custom" && entry.customType === CHECKPOINT_RESTORED_ENTRY) {
      // The message that checkpoint belonged to is no longer on this branch.
      checkpointId = undefined;
      continue;
    }
    if (entry.type === "custom" && entry.customType === TURN_END_ENTRY) {
      // The entry names the checkpoint of a message that is already listed; the message that comes next is not its concern.
      const end = parseStoredTurnEnd(entry.data);
      const index = items.findIndex((item) => item.type === "userMessage" && item.checkpointId === end?.checkpoint);
      const item = items[index];
      if (end && item?.type === "userMessage") items[index] = { ...item, changes: { files: end.files, ...(end.items ? { items: end.items } : {}) } };
      continue;
    }
    if (entry.type === "custom" && entry.customType === CHECKPOINT_UNDONE_ENTRY) {
      const undone = parseStoredCheckpointUndone(entry.data);
      const index = items.findIndex((item) => item.type === "userMessage" && item.checkpointId === undone?.checkpoint);
      const item = items[index];
      // The last undo of a turn says how it stands: one that left files as they are, until a later one puts those back too.
      if (undone && item?.type === "userMessage" && item.changes) {
        const pending = undone.reapply === undefined || Object.keys(undone.reapply).length > 0;
        items[index] = { ...item, changes: { files: item.changes.files, ...(item.changes.items ? { items: item.changes.items } : {}), ...(pending ? { undone: true, ...(undone.kept > 0 ? { kept: undone.kept } : {}) } : {}) } };
      }
      continue;
    }
    if (entry.type === "custom" && entry.customType === AGENT_ERROR_ENTRY) {
      const data = record(entry.data);
      const storedError = record(data?.error);
      if (data?.version !== 1 || typeof storedError?.message !== "string") continue;
      if (data.beforeUserMessage === true) {
        turnId = entry.id;
        storedPrompt = undefined;
        checkpointId = undefined;
      } else turnId ??= entry.id;
      const error = normalizeAgentError(storedError.message, storedError.diagnostics);
      const previous = items.findLastIndex((item) => item.turnId === turnId && item.type === "agentMessage");
      const item = items[previous];
      if (item?.type === "agentMessage" && item.status === "failed") items[previous] = { ...item, error };
      else items.push({ id: entry.id, turnId, type: "agentMessage", text: "", status: "failed", error, timestamp: Date.parse(entry.timestamp) });
      turnFinished = true;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const timestamp = messageTime(entry);
    if (timestamp !== undefined) lastTimestamp = timestamp;
    if (message.role === "user") {
      turnId = entry.id;
      turnFinished = false;
      const parsed = parseUserPrompt(textContent(message.content));
      const details = storedPrompt?.wirePromptHash === promptHash(textContent(message.content)) ? storedPrompt : undefined;
      storedPrompt = undefined;
      const checkpoint = checkpointId;
      checkpointId = undefined;
      const images = imageContent(message.content);
      const text = details?.prompt ?? parsed.text;
      const mentions = details?.mentions ?? parsed.mentions;
      const attachments = details?.attachments ?? parsed.attachments;
      const contexts = promptContextLabels(details?.attachmentContext ?? parsed.attachmentContext);
      if (text || images.length > 0 || attachments.length > 0) {
        items.push({ id: entry.id, turnId, type: "userMessage", text, ...(mentions.length ? { mentions } : {}), ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}), ...(contexts.length ? { contexts } : {}), ...(checkpoint ? { checkpointId: checkpoint } : {}), timestamp });
        if (images.length) items.push({ id: `${entry.id}:images`, turnId, type: "imageRead", count: images.length, status: "completed", timestamp });
      }
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
          const text = normalizeAssistantText(content.text);
          if (!text) continue;
          hasAssistantText = true;
          const phase = assistantMessagePhase(content, message.stopReason);
          items.push({
            id: `${entry.id}:assistant:${index}`,
            turnId,
            type: "agentMessage",
            text,
            status: threadItemStatus(message.stopReason),
            ...(phase ? { phase } : {}),
            timestamp,
            ...(message.stopReason === "error" ? { error: assistantMessageError(message) } : {}),
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
          ...(message.stopReason === "error" ? { error: assistantMessageError(message) } : {}),
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
          ? { ...questionnaire, status: "failed", error: normalizeAgentError(toolOutput(message).output || "Questionnaire failed"), timestamp }
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
        if (result.images?.length) tool.images = result.images;
        if (tool.type === "dynamicToolCall" && result.lineChanges) tool.lineChanges = result.lineChanges;
        if (tool.type === "dynamicToolCall" && result.fileDiff) tool.fileDiff = result.fileDiff;
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
      return { ...item, status: "failed", error: normalizeAgentError("Questionnaire interrupted") };
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
  onRunFinished?: (project: ProjectState, conversationId: string) => Promise<void>;
  /** Takes the snapshot that closes a turn, and counts the files that differ between two snapshots. */
  checkpoints?: {
    snapshot(project: ProjectState): Promise<string>;
    changed(project: ProjectState, from: string, to: string): Promise<TurnChanges>;
  };
  errorDiagnostics?: () => NonNullable<ThreadItemError["diagnostics"]>;
  onRunFailed?: (error: ThreadItemError, scope: { projectId: string; conversationId: string; turnId: string }) => void;
}

interface UndoneChanges {
  /** The snapshot of the workspace as it was just before the undo. */
  previous: string;
  /** Paths that were put back. */
  changed: string[];
  /** Paths that were left as they are. */
  conflicts: string[];
  reapply?: Record<string, string>;
  kept?: number;
}

interface ManagedSession {
  session: CodingSession;
  unsubscribe: () => void;
  designContext?: string;
}

interface ActiveTurn {
  project: ProjectState;
  projectId: string;
  conversationId: string;
  turnId: string;
  /** The checkpoint taken before the user message of this turn, once there is one. */
  checkpointId?: string;
  /** One for each user message of the run, in order. Undefined where the snapshot failed, so the turn before has no known end. */
  checkpoints: Array<{ id: string; commit: string } | undefined>;
  /** The session's last entry when the user message of this turn started. */
  entryBeforeMessage?: string;
  /** The run is over and only its end is still being recorded. */
  ended?: boolean;
  /** The entries of the conversation before the last message was edited, until the edited message starts. */
  left?: readonly SessionEntry[];
  prompt: string;
  mentions: PluginMention[];
  images: PromptImage[];
  references: PromptReference[];
  attachmentContext: string;
  attachments: ConversationAttachment[];
  mode: PlanMode;
  plan?: PlanState;
  conversation: StoredConversation;
  status: Extract<AgentStatus, "running" | "cancelling">;
  assistantItemIds: Map<number, string>;
  assistantTextNormalizers: Map<number, AssistantTextStreamNormalizer>;
  completedAssistantIndexes: Set<number>;
  assistantSequence: number;
  thinkingItemId?: string;
  thinkingSequence: number;
  preparingToolItemIds: Map<number, string>;
  toolItemIds: Map<string, string>;
  retryItemId?: string;
  userMessageStarted?: boolean;
  lastError?: ThreadItemError;
  retryAttempts?: number;
  items: Map<string, ThreadItem>;
  startedEventId?: number;
  startedAt?: number;
}

interface QueuedPrompt extends PendingPrompt {
  wirePrompt: string;
  attachmentContext: string;
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
  /** The projects whose files a restore, an undo or a put-back is changing. No turn starts in them meanwhile. */
  readonly #puttingBack = new Set<string>();
  readonly #turnEndsRecorded = new Map<string, number>();
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

  projectActivity(): ProjectAgentActivity[] {
    const statuses = new Map<string, ProjectAgentActivity["status"]>();
    for (const active of this.#activeTurns.values()) {
      // A run that has ended is not at work any more, although its turn is not closed yet.
      if (!active.ended && statuses.get(active.projectId) !== "running") statuses.set(active.projectId, active.status);
    }
    return [...statuses].map(([projectId, status]) => ({ projectId, status }));
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
    // A conversation reads as idle from the end of its run, a little before its turn is closed. What is asked of it
    // in between waits for that instead of being refused; with no such turn nothing is awaited.
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before cancelling the plan");
    await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before cancelling the plan");
    this.#setPlanState(project, conversation, { mode: "normal" });
  }

  async refinePlan(project: ProjectState, conversation: StoredConversation): Promise<void> {
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before refining the plan");
    await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before refining the plan");
    const state = this.planState(conversation);
    if (state.mode !== "awaiting_approval" || !state.plan) throw new Error("There is no plan waiting for refinement");
    this.#setPlanState(project, conversation, { mode: "planning", plan: state.plan });
  }

  async approvePlan(project: ProjectState, conversation: StoredConversation): Promise<{ turnId: string; result: Promise<AgentRunResult> }> {
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before approving the plan");
    await this.#getSession(project, conversation);
    if (this.#activeTurns.has(key)) throw new Error("Wait for the agent to finish before approving the plan");
    if (this.#puttingBack.has(project.id)) throw new Error(PUTTING_BACK);
    if (this.options.checkpoints && this.isProjectBusy(project.id)) throw new Error("Wait for the project agent to finish");
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
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) throw new Error("Wait for the agent to finish before changing models");
    const managed = this.#sessions.get(key);
    if (!managed) {
      persist();
      return;
    }
    if (!managed.session.setModel) throw new Error("The current agent session cannot change models");
    await managed.session.setModel(compatibleRuntimeModel(model));
  }

  async setReasoningLevel(
    projectId: string,
    conversationId: string,
    level: AgentReasoningLevel,
    persist: () => void,
  ): Promise<AgentReasoningLevel | undefined> {
    const key = conversationKey(projectId, conversationId);
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
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
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
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
      references: [],
      attachmentContext: "",
      attachments: [],
      mode: "normal",
      conversation,
      status: "running",
      assistantItemIds: new Map(),
      assistantTextNormalizers: new Map(),
      completedAssistantIndexes: new Set(),
      assistantSequence: 0,
      thinkingSequence: 0,
      preparingToolItemIds: new Map(),
      toolItemIds: new Map(),
      items: new Map(),
      checkpoints: [],
    };
    this.#activeTurns.set(key, active);
    this.#setState(project.id, conversation.summary.id, { status: "running" });

    let run: Promise<AgentRunResult>;
    const execution = managed.session.compact(customInstructions).then(() => "completed" as const);
    run = execution.then(
      (result) => {
        this.#finishCompact(project, active, run, { status: result });
        return result;
      },
      (cause) => {
        if (isCancelling(active)) {
          this.#finishCompact(project, active, run, { status: "cancelled" });
          return "cancelled" as const;
        }
        this.#finishCompact(project, active, run, { status: "failed", cause });
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
    attachmentContext = "",
    attachments: ConversationAttachment[] = [],
  ): { turnId: string; queued: boolean; result?: Promise<AgentRunResult | void> } {
    if (!prompt.trim() && images.length === 0 && !attachmentContext.trim()) throw new Error("Prompt must not be empty");
    if (this.#closing) throw new Error("Agent manager is closing");
    const key = conversationKey(project.id, conversation.summary.id);
    const active = this.#activeTurns.get(key);
    if (active?.ended) {
      // The conversation reads as idle, so this is a message for a new run and not one to queue in the run
      // that is over. It waits in the conversation's queue, behind the mutation that closes the turn, and is
      // then taken as if it had been sent a moment later.
      const taken = this.#withQueueMutation(key, async () => {
        // A turn that could not be closed is still there, and then nothing can start.
        if (this.#activeTurns.get(key) === active) throw new Error("Agent run is no longer active");
        const next = this.prompt(project, conversation, prompt, references, images, mode, mentions, turnId, attachmentContext, attachments);
        // A message queued behind the new run waits for a later mutation of this queue, so that is handed on and not awaited here.
        return { followUp: next.queued ? next.result : undefined };
      });
      return { turnId, queued: true, result: taken.then(({ followUp }) => followUp) };
    }
    // No turn may write files while a restore, an undo or a put-back changes them, whichever conversation asked for it.
    if (this.#puttingBack.has(project.id)) throw new Error(PUTTING_BACK);
    if (this.#revisions.has(key)) throw new Error("A message edit is already starting in this conversation");
    const planState = this.planState(conversation);
    if (mode === "normal" && planState.mode !== "normal") throw new Error("Finish or cancel the current plan before continuing");
    if (mode === "planning" && planState.mode === "executing") throw new Error("The plan is already executing");
    if (!active && this.options.checkpoints && this.isProjectBusy(project.id)) throw new Error("Wait for the other conversation in this project to finish");
    if (active) {
      if (mode !== "normal") throw new Error("Wait for the agent to finish before changing plan mode");
      if (active.status === "cancelling") throw new Error("Wait for the agent to stop");
      const result = this.#withQueueMutation(key, async () => {
        const managedDesign = this.#sessions.get(key);
        const metadata = await gameDesignMetadata(project, Boolean(managedDesign?.designContext));
        if (managedDesign) managedDesign.designContext = metadata;
        const privateContext = withProjectDesignContext(attachmentContext, metadata);
        const wirePrompt = `${promptWithReferences(skillInvocationPrompt(serializePluginMentions(prompt, mentions)), references)}${privateContext}`;
        const event = this.events.publish(
          project.id,
          "prompt.queued",
          { prompt, ...(mentions.length ? { mentions } : {}), references, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) },
          { conversationId: conversation.summary.id, turnId },
          images.length ? { prompt, references } : undefined,
        );
        const queued = { turnId, prompt, mentions, references, images, attachments, attachmentContext: privateContext, wirePrompt, queuedEventId: event.id };
        this.#pendingPrompts.set(key, [...(this.#pendingPrompts.get(key) ?? []), queued]);
        const unqueue = () => {
          const pending = this.#pendingPrompts.get(key) ?? [];
          this.#pendingPrompts.set(key, pending.filter((item) => item.turnId !== turnId));
          this.events.publish(project.id, "prompt.removed", {}, { conversationId: conversation.summary.id, turnId });
        };
        try {
          const managed = await this.#getSession(project, conversation);
          const current = this.#activeTurns.get(key);
          if (!current || current.status !== "running") {
            throw new Error("Agent run is no longer active");
          }
          if (!current.ended) {
            if (!managed.session.followUp) throw new Error("The current agent session cannot queue follow-ups");
            await managed.session.followUp(wirePrompt, images.length ? images.map(toPiImage) : undefined);
            return {};
          }
        } catch (cause) {
          unqueue();
          throw cause;
        }
        // The run ended while the message was on its way here, so there is no run left to queue it behind. It is
        // taken as a message for a new run, which waits behind the mutation that closes the turn. That one comes
        // after this one, so its outcome is handed on and not awaited here.
        unqueue();
        return { held: this.prompt(project, conversation, prompt, references, images, mode, mentions, turnId, attachmentContext, attachments).result };
      });
      return { turnId, queued: true, result: result.then(({ held }) => held) };
    }

    this.#pendingPrompts.delete(key);
    if (mode === "planning") this.#setPlanState(project, conversation, { mode: "planning", ...(planState.plan ? { plan: planState.plan } : {}) }, false);
    return { turnId, queued: false, result: this.#startPrompt(project, conversation, prompt, references, images, turnId, undefined, mode, planState.plan, mentions, attachmentContext, attachments) };
  }

  async reviseLast(
    project: ProjectState,
    conversation: StoredConversation,
    prompt: string,
    validateReference: (reference: PromptReference) => Promise<PromptReference>,
  ): Promise<{ turnId: string; result: Promise<AgentRunResult> }> {
    if (!prompt.trim()) throw new Error("Prompt must not be empty");
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#activeTurns.get(key)?.ended) await this.#turnClosed(key);
    if (this.#closing) throw new Error("Agent manager is closing");
    if (this.planState(conversation).mode !== "normal") throw new Error("Finish or cancel the current plan before editing a message");
    if (this.#puttingBack.has(project.id)) throw new Error(PUTTING_BACK);
    if (this.options.checkpoints && this.isProjectBusy(project.id)) throw new Error("Wait for the project agent to finish");
    if (this.#activeTurns.has(key) || this.#revisions.has(key)) {
      throw new Error("Wait for the agent to finish before editing a message");
    }
    if ((this.#pendingPrompts.get(key)?.length ?? 0) > 0 || (this.#steeringPrompts.get(key)?.length ?? 0) > 0) {
      throw new Error("Remove queued messages before editing a message");
    }

    this.#revisions.add(key);
    let navigated = false;
    try {
      const previous = lastUserPrompt(project, conversation.sessionPath);
      if (!previous) throw new Error("There is no user message to edit");
      const references = await Promise.all(previous.references.map(validateReference));
      const managed = await this.#getSession(project, conversation);
      if (!managed.session.navigateTree) throw new Error("The current agent session cannot edit messages");
      const left = managed.session.sessionManager?.getBranch() ?? [];
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
          previous.attachmentContext,
          previous.attachments,
          left,
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

  /**
   * Puts the workspace and the conversation back to just before the user
   * message a checkpoint was taken for. `restoreFiles` restores the workspace
   * to a snapshot and persists the rewind before completing the file operation.
   */
  async restoreCheckpoint(
    project: ProjectState,
    conversation: StoredConversation,
    checkpointId: string,
    restoreFiles: (commit: string, rewind: (previous: string) => Promise<void>) => Promise<unknown>,
  ): Promise<void> {
    await this.turnsClosed(project.id);
    if (this.#closing) throw new Error("Agent manager is closing");
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.planState(conversation).mode !== "normal") throw new Error("Finish or cancel the current plan before restoring");
    if (this.#puttingBack.has(project.id)) throw new Error(PUTTING_BACK);
    // Any conversation of the project may be changing the same workspace.
    if (this.isProjectBusy(project.id)) throw new Error("Wait for the agent to finish before restoring");
    if ((this.#pendingPrompts.get(key)?.length ?? 0) > 0 || (this.#steeringPrompts.get(key)?.length ?? 0) > 0) {
      throw new Error("Remove queued messages before restoring");
    }

    this.#revisions.add(key);
    this.#puttingBack.add(project.id);
    try {
      const { session } = await this.#getSession(project, conversation);
      const sessionManager = session.sessionManager;
      const navigate = session.navigateTree?.bind(session);
      const selectBranch = sessionManager?.branch?.bind(sessionManager);
      if (!navigate || !selectBranch || !sessionManager) throw new Error("The current agent session cannot restore checkpoints");
      const branch = sessionManager.getBranch();
      const index = branch.findIndex((entry) => entry.id === checkpointId);
      const entry = branch[index];
      const checkpoint = entry?.type === "custom" && entry.customType === CHECKPOINT_ENTRY ? parseStoredCheckpoint(entry.data) : undefined;
      const message = checkpoint && branch.slice(index + 1).find((candidate) => candidate.type === "message" && candidate.message.role === "user");
      const originalLeaf = branch.at(-1)?.id;
      if (!checkpoint || !message || !originalLeaf) throw new CheckpointNotFoundError();

      await restoreFiles(checkpoint.commit, async (undo) => {
        try {
          // Pi does not navigate away from its current leaf. After an interrupted
          // answer the user message itself can be that leaf; select its checkpoint.
          const target = branch.at(-1) === message ? checkpointId : message.id;
          const navigation = await navigate(target, { summarize: false });
          if (navigation.cancelled) throw new Error("Restore was cancelled");
          // Pi moves back in memory only; an entry after the move makes it the conversation's end on disk too.
          sessionManager.appendCustomEntry(CHECKPOINT_RESTORED_ENTRY, { version: 1, checkpoint: checkpointId, undo });
          carryTurnEnds(sessionManager, branch);
          appendPlanState(sessionManager, { mode: "normal" });
        } catch (cause) {
          try {
            selectBranch(originalLeaf);
            appendPlanState(sessionManager, { mode: "normal" });
          } catch (rollback) {
            throw new AggregateError([cause, rollback], "Could not restore the conversation after a failed rewind");
          } finally {
            this.#forgetConversation(key);
          }
          throw cause;
        }
      });
    } finally {
      this.#revisions.delete(key);
      this.#puttingBack.delete(project.id);
      this.#flushInvalidatedProject(project.id);
    }
  }

  /**
   * Takes back the file changes of the turn a checkpoint was taken for and
   * leaves the conversation as it is. `undo` puts the files of the range
   * back and returns the paths it changed and the ones it left as they are.
   */
  async undoCheckpoint(
    project: ProjectState,
    conversation: StoredConversation,
    checkpointId: string,
    undo: (range: TurnRange, state?: StoredCheckpointUndone) => Promise<UndoneChanges>,
    direction: "undo" | "reapply" = "undo",
  ): Promise<UndoneChanges> {
    await this.turnsClosed(project.id);
    if (this.#closing) throw new Error("Agent manager is closing");
    const key = conversationKey(project.id, conversation.summary.id);
    if (this.#puttingBack.has(project.id)) throw new Error(PUTTING_BACK);
    // Any conversation of the project may be changing the same workspace.
    if (this.isProjectBusy(project.id)) throw new Error("Wait for the agent to finish before undoing");

    this.#revisions.add(key);
    this.#puttingBack.add(project.id);
    try {
      const { session } = await this.#getSession(project, conversation);
      const sessionManager = session.sessionManager;
      const branch = sessionManager?.getBranch();
      const range = branch && turnRange(branch, checkpointId);
      if (!sessionManager || !range) throw new CheckpointNotFoundError();

      const records = branch!
        .flatMap((entry) =>
          entry.type === "custom" &&
          entry.customType === CHECKPOINT_UNDONE_ENTRY
            ? [parseStoredCheckpointUndone(entry.data)]
            : [],
        )
        .filter(
          (entry): entry is StoredCheckpointUndone =>
            entry?.checkpoint === checkpointId,
        );
      const last = records.at(-1);
      const state = last && {
        ...last,
        ...(last.reapply === undefined
          ? { previous: records[0]!.previous }
          : {}),
      };
      if (direction === "reapply" && !state)
        throw new Error("There are no undone changes to reapply");
      const result = await undo(range, state);
      const pending = new Map(
        Object.entries(result.reapply ?? state?.reapply ?? {}),
      );
      if (direction === "undo")
        for (const file of result.changed) {
          // A file and its descendants cannot come from incompatible snapshots.
          // Repeating Undo on a file/folder replacement supersedes that whole shape.
          for (const pendingPath of pending.keys())
            if (
              pendingPath.startsWith(`${file}/`) ||
              file.startsWith(`${pendingPath}/`)
            )
              pending.set(pendingPath, result.previous);
          pending.set(file, result.previous);
        }
      else if (result.reapply === undefined)
        for (const file of result.changed) pending.delete(file);
      const reapply = Object.fromEntries(pending);
      const kept = result.kept ?? (pending.size ? result.conflicts.length : 0);
      // An undo that only met files to leave alone has undone nothing, and can be asked for again.
      if (result.changed.length > 0 || result.conflicts.length === 0) {
        const undone: StoredCheckpointUndone = { version: 1, checkpoint: checkpointId, previous: result.previous, kept, reapply };
        sessionManager.appendCustomEntry(CHECKPOINT_UNDONE_ENTRY, undone);
      }
      return { ...result, reapply, kept };
    } finally {
      this.#revisions.delete(key);
      this.#puttingBack.delete(project.id);
      this.#flushInvalidatedProject(project.id);
    }
  }

  /**
   * Puts the workspace back to where a restore or an undo that was cut off
   * had started. That is no conversation's own doing and leaves all of them
   * as they are. `restoreFiles` restores the workspace.
   */
  async restoreUnfinished(project: ProjectState, restoreFiles: () => Promise<void>): Promise<void> {
    await this.turnsClosed(project.id);
    if (this.#closing) throw new Error("Agent manager is closing");
    if (this.#puttingBack.has(project.id)) throw new Error(PUTTING_BACK);
    if (this.isProjectBusy(project.id)) throw new Error("Wait for the agent to finish before restoring");

    this.#puttingBack.add(project.id);
    try {
      await restoreFiles();
    } finally {
      this.#puttingBack.delete(project.id);
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
    attachmentContext = "",
    attachments: ConversationAttachment[] = [],
    left?: readonly SessionEntry[],
  ): Promise<AgentRunResult> {

    const active: ActiveTurn = {
      project,
      projectId: project.id,
      conversationId: conversation.summary.id,
      turnId,
      prompt,
      mentions,
      images,
      references,
      attachmentContext,
      attachments,
      mode,
      conversation,
      plan,
      status: "running",
      assistantItemIds: new Map(),
      assistantTextNormalizers: new Map(),
      completedAssistantIndexes: new Set(),
      assistantSequence: 0,
      thinkingSequence: 0,
      preparingToolItemIds: new Map(),
      toolItemIds: new Map(),
      items: new Map(),
      checkpoints: [],
      ...(left ? { left } : {}),
    };
    this.#activeTurns.set(conversationKey(project.id, active.conversationId), active);
    this.#setState(project.id, active.conversationId, { status: "running" });
    const contexts = promptContextLabels(attachmentContext);
    const started = this.events.publish(
      project.id,
      "agent.started",
      { prompt, ...(mentions.length ? { mentions } : {}), ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}), ...(contexts.length ? { contexts } : {}), ...(revision ? { revision } : {}) },
      eventScope(active),
      images.length ? { prompt, ...(revision ? { revision } : {}) } : undefined,
    );
    active.startedEventId = started.id;
    active.startedAt = Date.parse(started.timestamp);
    const mentionedPrompt = serializePluginMentions(prompt, mentions);
    const invocation = mode === "normal" ? skillInvocationPrompt(mentionedPrompt) : mentionedPrompt;
    const basePrompt = mode === "planning"
      ? planningPrompt(promptWithReferences(invocation, references))
      : mode === "executing"
        ? executionPrompt(promptWithReferences(invocation, references), active.plan)
        : promptWithReferences(invocation, references);
    const wirePrompt = `${basePrompt}${attachmentContext}`;
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
    let managed: ManagedSession;
    try {
      managed = await this.#getSession(project, conversation);
      if (active.mode === "planning" || active.mode === "executing") {
        appendPlanState(managed.session.sessionManager, {
          mode: active.mode,
          ...(active.plan ? { plan: active.plan } : {}),
        });
      }
      const basePrompt = active.attachmentContext ? prompt.slice(0, -active.attachmentContext.length) : prompt;
      managed.designContext = await gameDesignMetadata(project, Boolean(managed.designContext));
      active.attachmentContext = withProjectDesignContext(active.attachmentContext, managed.designContext);
      prompt = `${basePrompt}${active.attachmentContext}`;
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }

      const activeTools = this.options.activeToolNames?.(project, active.mode, managed.session) ?? BASE_TOOL_NAMES;
      managed.session.setActiveToolsByName?.(managed.session.getAllTools?.().some((tool) => tool.name === "recall_image")
        ? [...new Set([...activeTools, "recall_image"])] : activeTools);
      appendPromptDetails(managed.session.sessionManager, active, prompt);
      if (images.length) {
        await managed.session.prompt(prompt, { images: images.map(toPiImage) });
      } else {
        await managed.session.prompt(prompt);
      }
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }
    } catch (cause) {
      if (isCancelling(active)) {
        this.#markCancelled(project.id, active);
        return "cancelled";
      }
      const error = thrownAgentError(cause);
      this.#markError(project.id, active, active.lastError?.message === error.message ? active.lastError : error);
      throw cause;
    }

    const error = lastAssistantError(managed.session.messages);
    if (error) {
      this.#markError(project.id, active, error);
      throw new Error(error.message);
    }
    this.#completeOpenItems(project.id, active, "completed");
    this.#setState(project.id, active.conversationId, { status: "idle" });
    this.events.publish(project.id, "agent.completed", {}, eventScope(active));
    return "completed";
  }

  async cancel(projectId: string, conversationId: string, turnId: string): Promise<void> {
    const key = conversationKey(projectId, conversationId);
    const active = this.#activeTurns.get(key);
    // A run that is over has nothing left to stop.
    if (!active || active.turnId !== turnId || active.status !== "running" || active.ended) return;
    active.status = "cancelling";
    this.#setState(projectId, conversationId, { status: "cancelling" });
    const managed = this.#sessions.get(key);
    if (managed) {
      await this.#withQueueMutation(key, async () => {
        managed.session.clearQueue?.();
        this.#clearPending(projectId, conversationId);
      });
      managed.session.abortCompaction?.();
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
      const steered = current[index];
      this.events.publish(projectId, "prompt.steered", {
        prompt: steered.prompt,
        ...(steered.mentions.length ? { mentions: steered.mentions } : {}),
        references: steered.references,
        ...(steered.images.length ? { images: steered.images } : {}),
        ...(steered.attachments.length ? { attachments: steered.attachments } : {}),
      }, { conversationId, turnId }, steered.images.length ? { prompt: steered.prompt, references: steered.references } : undefined);
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

  /** Waits for the turn of a conversation whose run has ended to be closed. The daemon may have begun to close meanwhile. */
  async #turnClosed(key: string): Promise<void> {
    await this.#queueMutations.get(key);
    if (this.#closing) throw new Error("Agent manager is closing");
  }

  /**
   * Waits until the turns of a project that have ended are closed. A
   * conversation reads as idle from the moment its turn ends, a little
   * before the end is recorded and the project stops being busy. What the
   * player asks for in between waits here instead of being refused.
   */
  async turnsClosed(projectId: string): Promise<void> {
    const prefix = `${projectId}:`;
    await Promise.all([...this.#queueMutations].flatMap(([key, mutation]) => key.startsWith(prefix) ? [mutation] : []));
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
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId: item.turnId });
    }
    for (const item of pending) {
      if (item.images.length) this.events.expireThrough(projectId, item.queuedEventId);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId: item.turnId });
    }
  }

  pendingPrompts(projectId: string, conversationId: string): PendingPrompt[] {
    const key = conversationKey(projectId, conversationId);
    const steering = (this.#steeringPrompts.get(key) ?? []).map(({ turnId, prompt, mentions, references, images, attachments }) => ({
      turnId, prompt, mentions, references, images, attachments, steering: true,
    }));
    const pending = (this.#pendingPrompts.get(key) ?? []).map(({ turnId, prompt, mentions, references, images, attachments }) => ({
      turnId, prompt, mentions, references, images, attachments,
    }));
    return [...steering, ...pending];
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
    const timestamp = active.startedAt === undefined ? {} : { timestamp: active.startedAt };
    const contexts = promptContextLabels(active.attachmentContext);
    return [{
      id: `${active.turnId}:user`,
      turnId: active.turnId,
      type: "userMessage",
      text: active.prompt,
      ...(active.mentions.length ? { mentions: active.mentions } : {}),
      ...(active.images.length ? { images: active.images } : {}),
      ...(active.attachments.length ? { attachments: active.attachments } : {}),
      ...(contexts.length ? { contexts } : {}),
      ...(active.checkpointId ? { checkpointId: active.checkpointId } : {}),
      ...timestamp,
    }, ...(active.images.length ? [{
      id: `${active.turnId}:images`,
      turnId: active.turnId,
      type: "imageRead" as const,
      count: active.images.length,
      status: "completed" as const,
      ...timestamp,
    }] : []), ...active.items.values()];
  }

  /** The turn that is in progress. One whose run is over is not, though it is listed from memory until its end is recorded. */
  activeTurnId(projectId: string, conversationId: string): string | undefined {
    const active = this.#activeTurns.get(conversationKey(projectId, conversationId));
    return active?.ended ? undefined : active?.turnId;
  }

  /**
   * How many turn ends were written for a conversation since the daemon
   * started. One that is written late comes with no run starting or ending,
   * so this is what tells a reader of the session file that it changed.
   */
  turnEndsRecorded(projectId: string, conversationId: string): number {
    return this.#turnEndsRecorded.get(conversationKey(projectId, conversationId)) ?? 0;
  }

  activeStart(projectId: string, conversationId: string): { id: number; timestamp: string } | undefined {
    const active = this.#activeTurns.get(conversationKey(projectId, conversationId));
    if (!active || active.startedEventId === undefined || active.startedAt === undefined) return undefined;
    return { id: active.startedEventId, timestamp: new Date(active.startedAt).toISOString() };
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
    for (const { session } of sessions) session.abortCompaction?.();
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
    // Set together with queueing the mutation that closes the turn, so whatever then waits in this queue comes after it.
    // Since the event that ended the run nothing from outside has had a turn: only promise callbacks ran in between.
    active.ended = true;
    await this.#withQueueMutation(key, async () => {
      if (this.#activeTurns.get(key) !== active) return;
      // An edit can fail before its replacement message starts. Preserve the
      // earlier turns on the branch selected by the edit in that case too.
      if (active.left) {
        try {
          const sessionManager = this.#sessions.get(key)?.session.sessionManager;
          if (sessionManager) carryTurnEnds(sessionManager, active.left, true);
        } catch {
          console.warn("Could not preserve earlier turn checkpoints");
        }
        active.left = undefined;
      }
      // The turn is still active, so no prompt, edit or restore moves the conversation on before its end is written.
      const ends = await this.#turnEnds(project, active);
      this.#recordTurnEnds(projectId, active, ends);
      this.#activeTurns.delete(key);
      const questionnaire = this.#questionnaires.get(key);
      if (questionnaire) {
        questionnaire.removeAbortListener?.();
        this.#completeItem(projectId, active, {
          ...questionnaire.item,
          status: "failed",
          error: normalizeAgentError("Planning ended before the questionnaire was answered"),
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

  /**
   * Cleans up after a run and works out where each of its turns ended. The
   * last one ends with the workspace as it is now; an earlier one ends where
   * the next message's checkpoint was taken. A turn whose end is not known
   * is left out.
   *
   * Messages, restores and undos wait for the turn to be closed, so the
   * snapshot gets CLOSING_MS and the turn is then closed without its ends.
   * The cleanup is waited for however long it takes: the playtest driver
   * gives up on a request by itself, and a run that started before the
   * cleanup of the one before it was over could have its game windows closed
   * by it.
   */
  async #turnEnds(project: ProjectState, active: ActiveTurn): Promise<StoredTurnEnd[]> {
    try {
      await this.options.onRunFinished?.(project, active.conversationId);
    } catch {
      // The conversation reads as idle from the end of the run. With the turn left open nothing could be asked of
      // it until the daemon starts again, so a cleanup that fails does not stop the turn from being closed.
      console.warn("Could not clean up after the run");
    }
    const checkpoints = this.options.checkpoints;
    if (!checkpoints || !active.checkpoints.some(Boolean)) return [];
    const found = async (): Promise<StoredTurnEnd[]> => {
      try {
        const last = await checkpoints.snapshot(project);
        const ends: StoredTurnEnd[] = [];
        for (const [index, checkpoint] of active.checkpoints.entries()) {
          const commit = index === active.checkpoints.length - 1 ? last : active.checkpoints[index + 1]?.commit;
          if (!checkpoint || !commit) continue;
          ends.push({ version: 1, checkpoint: checkpoint.id, commit, ...await checkpoints.changed(project, checkpoint.commit, commit) });
        }
        return ends;
      } catch {
        // The run ends all the same; its turns only have no changes to show and nothing to undo.
        console.warn("Could not take the snapshot that closes the turn");
        return [];
      }
    };
    // Asked for while the turn is still open, the snapshot is where the run ended whenever it comes back: the store
    // takes one snapshot of a project at a time, so the checkpoint of the next turn waits behind it.
    const work = found();
    const ends = await within(work, CLOSING_MS);
    if (ends !== TOO_LONG) return ends;
    console.warn("Could not close the turn in time");
    // The ends are recorded when they are there, wherever the conversation has got to; they are found by the
    // checkpoint they name.
    void work.then((late) => { if (!this.#closing) this.#recordTurnEnds(project.id, active, late, true); });
    return [];
  }

  /**
   * Stores the ends of a run's turns and tells the conversation. Nothing is
   * awaited, so a reader sees the turn gone and its end together. Ends that
   * come late may find the session let go, and are then written to the
   * conversation's file if that is still there.
   */
  #recordTurnEnds(projectId: string, active: ActiveTurn, ends: StoredTurnEnd[], late = false): void {
    if (ends.length === 0) return;
    const key = conversationKey(projectId, active.conversationId);
    try {
      const { sessionPath } = active.conversation;
      const sessionManager = this.#sessions.get(key)?.session.sessionManager
        ?? (late && !this.#sessionLoads.has(key) && existsSync(sessionPath) ? SessionManager.open(sessionPath, sessionDirectory(active.project), active.project.workspacePath) : undefined);
      if (!sessionManager) return;
      for (const end of ends) {
        sessionManager.appendCustomEntry(TURN_END_ENTRY, end);
        this.#turnEndsRecorded.set(key, (this.#turnEndsRecorded.get(key) ?? 0) + 1);
        // Turn ids differ between the live and the stored conversation; the checkpoint id does not.
        this.events.publish(projectId, "checkpoint.completed", { checkpointId: end.checkpoint, files: end.files, ...(end.items ? { items: end.items } : {}) }, { conversationId: active.conversationId });
      }
    } catch {
      console.warn("Could not save where the turn ended");
    }
  }

  #finishCompact(project: ProjectState, active: ActiveTurn, run: Promise<AgentRunResult>, outcome: CompactRunOutcome): void {
    this.#runs.delete(run);
    const key = conversationKey(project.id, active.conversationId);
    if (this.#activeTurns.get(key) === active) {
      if (outcome.status === "cancelled") {
        this.#completeOpenItems(project.id, active, "cancelled");
        this.#activeTurns.delete(key);
        this.#setState(project.id, active.conversationId, { status: "idle" });
        this.events.publish(project.id, "agent.cancelled", {}, eventScope(active));
        this.#flushInvalidatedProject(project.id);
        return;
      }
      const error = outcome.status === "failed"
        ? outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause)
        : undefined;
      this.#completeOpenItems(project.id, active, error ? "failed" : "completed", error ? normalizeAgentError(error) : undefined);
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
      state,
      SessionManager.open(stored.sessionPath, sessionDirectory(state), state.workspacePath),
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
      const initialMessage = !active.userMessageStarted;
      active.userMessageStarted = true;
      const key = conversationKey(projectId, conversationId);
      const sessionManager = this.#sessions.get(key)?.session.sessionManager;
      // The edit of a message holds from here on.
      if (active.left && sessionManager) carryTurnEnds(sessionManager, active.left, true);
      active.left = undefined;
      active.entryBeforeMessage = sessionManager?.getBranch().at(-1)?.id;
      if (initialMessage && this.#sessions.get(key)?.session.emitsInitialUserMessage) return;
      const steering = this.#steeringPrompts.get(key) ?? [];
      const pending = this.#pendingPrompts.get(key) ?? [];
      const started = steering[0] ?? pending[0];
      if (!started) return;
      appendPromptDetails(this.#sessions.get(key)?.session.sessionManager, started, started.wirePrompt);
      if (steering.length > 0) this.#steeringPrompts.set(key, steering.slice(1));
      else this.#pendingPrompts.set(key, pending.slice(1));
      if (active.images.length && active.startedEventId !== undefined) this.events.expireThrough(projectId, active.startedEventId);
      if (started.images.length) this.events.expireThrough(projectId, started.queuedEventId);
      active.turnId = started.turnId;
      active.checkpointId = undefined;
      active.prompt = started.prompt;
      active.mentions = started.mentions;
      active.images = started.images;
      active.references = started.references;
      active.attachmentContext = started.attachmentContext;
      active.attachments = started.attachments;
      active.assistantItemIds.clear();
      active.assistantTextNormalizers.clear();
      active.completedAssistantIndexes.clear();
      active.assistantSequence = 0;
      active.thinkingItemId = undefined;
      active.thinkingSequence = 0;
      active.preparingToolItemIds.clear();
      active.toolItemIds.clear();
      active.retryItemId = undefined;
      active.lastError = undefined;
      active.retryAttempts = undefined;
      active.items.clear();
      this.#setState(projectId, conversationId, { status: "running" });
      const startedEvent = this.events.publish(
        projectId,
        "agent.started",
        { prompt: started.prompt, ...(started.mentions.length ? { mentions: started.mentions } : {}), ...(started.images.length ? { images: started.images } : {}), ...(started.attachments.length ? { attachments: started.attachments } : {}) },
        eventScope(active),
        started.images.length ? { prompt: started.prompt } : undefined,
      );
      active.startedEventId = startedEvent.id;
      active.startedAt = Date.parse(startedEvent.timestamp);
      this.events.publish(projectId, "prompt.removed", {}, { conversationId, turnId: started.turnId });
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      active.assistantTextNormalizers.set(contentIndex, new AssistantTextStreamNormalizer());
      active.completedAssistantIndexes.delete(contentIndex);
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
      const normalizer = active.assistantTextNormalizers.get(contentIndex) ?? new AssistantTextStreamNormalizer();
      active.assistantTextNormalizers.set(contentIndex, normalizer);
      const delta = normalizer.push(event.assistantMessageEvent.delta);
      const itemId = active.assistantItemIds.get(contentIndex) ?? (normalizer.text
        ? `${active.turnId}:assistant:${active.assistantSequence++}`
        : undefined);
      if (!itemId) return;
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
      if (delta) {
        this.#appendItemText(active, itemId, delta);
        this.events.publish(projectId, "item.agentMessage.delta", { itemId, delta }, eventScope(active));
      }
      const item = active.items.get(itemId);
      if (item?.type === "agentMessage" && item.text !== normalizer.text) {
        this.#updateItem(projectId, active, { ...item, text: normalizer.text });
      }
    } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      const contentIndex = event.assistantMessageEvent.contentIndex;
      const normalizer = active.assistantTextNormalizers.get(contentIndex) ?? new AssistantTextStreamNormalizer();
      active.assistantTextNormalizers.set(contentIndex, normalizer);
      const delta = normalizer.finish(event.assistantMessageEvent.content);
      const text = normalizer.text;
      let itemId = active.assistantItemIds.get(contentIndex);
      if (!itemId && text) {
        itemId = `${active.turnId}:assistant:${active.assistantSequence++}`;
        active.assistantItemIds.set(contentIndex, itemId);
        this.#startItem(projectId, active, {
          id: itemId,
          turnId: active.turnId,
          type: "agentMessage",
          text: "",
          status: "inProgress",
        });
      }
      if (itemId) {
        if (delta) {
          this.#appendItemText(active, itemId, delta);
          this.events.publish(projectId, "item.agentMessage.delta", { itemId, delta }, eventScope(active));
        }
        const phase = assistantBlockPhase(event.assistantMessageEvent.partial.content[contentIndex]);
        const item = active.items.get(itemId);
        if (phase && item?.type === "agentMessage") {
          this.#completeItem(projectId, active, {
            ...item,
            text,
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
    } else if (event.type === "message_end" && isUserMessage(event.message)) {
      // The checkpoint extension has run by now and Pi has not stored the message yet, so the entry is among those
      // added since the message started; the end of an earlier turn may have been recorded after it. An entry
      // that was there already is not this message's: after an edit the last one is the checkpoint of the message
      // that was replaced, and stays the last one when the snapshot then fails.
      const branch = this.#sessions.get(conversationKey(projectId, conversationId))?.session.sessionManager?.getBranch() ?? [];
      const before = branch.findIndex((candidate) => candidate.id === active.entryBeforeMessage);
      // Where the message started is not known in a session that was empty then; its checkpoint is the last entry.
      const added = before < 0 ? branch.slice(-1) : branch.slice(before + 1);
      const entry = added.findLast((candidate) => candidate.type === "custom" && candidate.customType === CHECKPOINT_ENTRY);
      const checkpoint = entry?.type === "custom" ? parseStoredCheckpoint(entry.data) : undefined;
      active.checkpoints.push(entry && checkpoint ? { id: entry.id, commit: checkpoint.commit } : undefined);
      if (entry && checkpoint) {
        active.checkpointId = entry.id;
        this.events.publish(projectId, "checkpoint.created", { checkpointId: entry.id }, eventScope(active));
      }
    } else if (event.type === "message_end" && isAssistantMessage(event.message)) {
      const status = threadItemStatus(event.message.stopReason);
      active.lastError = event.message.stopReason === "error" ? this.#turnError(active, assistantMessageError(event.message)) : undefined;
      for (const [contentIndex, itemId] of active.assistantItemIds) {
        if (status === "completed" && active.completedAssistantIndexes.has(contentIndex)) continue;
        const content = Array.isArray(event.message.content) ? event.message.content[contentIndex] : undefined;
        const phase = assistantMessagePhase(content, event.message.stopReason);
        const item = active.items.get(itemId);
        if (item?.type !== "agentMessage") continue;
        this.#completeItem(projectId, active, {
          ...item,
          ...(content && content.type === "text" ? { text: normalizeAssistantText(content.text) } : {}),
          status,
          ...(phase ? { phase } : {}),
          ...(active.lastError ? { error: active.lastError } : {}),
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
          ...(active.lastError ? { error: active.lastError } : {}),
        };
        this.#startItem(projectId, active, { ...item, status: "inProgress" });
        this.#completeItem(projectId, active, item);
      }
      active.assistantItemIds.clear();
      active.assistantTextNormalizers.clear();
      active.completedAssistantIndexes.clear();
      active.preparingToolItemIds.clear();
    } else if (event.type === "auto_retry_start") {
      active.retryAttempts = (active.retryAttempts ?? 0) + 1;
      const item: Extract<ThreadItem, { type: "retry" }> = {
        id: `${active.turnId}:retry`,
        turnId: active.turnId,
        type: "retry",
        status: "inProgress",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: this.#retryError(active, event.errorMessage),
      };
      active.retryItemId = item.id;
      this.#updateItem(projectId, active, item);
    } else if (event.type === "auto_retry_end") {
      const item = active.retryItemId ? active.items.get(active.retryItemId) : undefined;
      if (item?.type === "retry") {
        this.#completeItem(projectId, active, {
          ...item,
          status: event.success ? "completed" : "failed",
          ...(!event.success ? { error: this.#retryError(active, event.finalError ?? active.lastError?.message ?? item.error.message) } : {}),
        });
        if (event.success) active.items.delete(item.id);
      }
      active.retryItemId = undefined;
    } else if (event.type === "compaction_start") {
      const started = this.#startItem(projectId, active, {
        id: `${active.turnId}:compaction`,
        turnId: active.turnId,
        type: "contextCompaction",
        status: "inProgress",
      });
      active.startedEventId ??= started.id;
      active.startedAt ??= Date.parse(started.timestamp);
    } else if (event.type === "compaction_end") {
      const stopped = event.aborted && isCancelling(active);
      const status = stopped ? "cancelled" : event.aborted || event.errorMessage ? "failed" : "completed";
      const error = event.errorMessage ?? (event.aborted
        ? event.willRetry ? "Context compaction interrupted; retrying" : stopped ? "Context compaction stopped" : "Context compaction interrupted"
        : undefined);
      this.#completeItem(projectId, active, {
        id: `${active.turnId}:compaction`,
        turnId: active.turnId,
        type: "contextCompaction",
        status,
        ...(event.result ? {
          summary: event.result.summary,
          tokensBefore: event.result.tokensBefore,
          estimatedTokensAfter: event.result.estimatedTokensAfter,
        } : {}),
        ...(error ? { error: normalizeAgentError(error) } : {}),
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

  #startItem(projectId: string, active: ActiveTurn, item: ThreadItem) {
    active.items.set(item.id, item);
    return this.events.publish(projectId, "item.started", { item }, eventScope(active));
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

  #completeOpenItems(projectId: string, active: ActiveTurn, status: "completed" | "cancelled" | "failed", error?: ThreadItemError): void {
    for (const item of active.items.values()) {
      if (item.type === "agentMessage" && item.status === "inProgress") {
        this.#completeItem(projectId, active, { ...item, status, ...(status === "failed" && error ? { error } : {}) });
      } else if (item.type === "reasoning" && item.status === "inProgress") {
        this.#completeItem(projectId, active, { ...item, status: "completed" });
      } else if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") &&
        (item.status === "preparing" || item.status === "inProgress")) {
        this.#completeItem(projectId, active, { ...item, status: "failed" });
      } else if (item.type === "contextCompaction" && item.status === "inProgress") {
        this.#completeItem(projectId, active, {
          ...item,
          status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed",
          ...(error ? { error } : {}),
        });
      } else if (item.type === "retry" && item.status === "inProgress") {
        this.#completeItem(projectId, active, {
          ...item,
          status: status === "completed" ? "completed" : "failed",
          ...(error ? { error } : {}),
        });
      } else if (item.type === "userInputRequest" && item.status === "inProgress") {
        this.#completeItem(projectId, active, {
          ...item,
          status: status === "cancelled" ? "cancelled" : "failed",
          ...(error ? { error } : {}),
        });
      }
    }
  }

  #ensureTerminalAgentItem(projectId: string, active: ActiveTurn, status: "cancelled" | "failed", error?: ThreadItemError): void {
    const previous = [...active.items.values()].findLast((item) => item.type === "agentMessage");
    if (previous?.type === "agentMessage" && previous.status === status) {
      if (error && previous.error !== error) this.#completeItem(projectId, active, { ...previous, error });
      return;
    }
    const item: Extract<ThreadItem, { type: "agentMessage" }> = {
      id: `${active.turnId}:status`,
      turnId: active.turnId,
      type: "agentMessage",
      text: "",
      status,
      ...(error ? { error } : {}),
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

  #retryError(active: ActiveTurn, message: string): ThreadItemError {
    const error = normalizeAgentError(message);
    return this.#turnError(active, active.lastError?.message === error.message ? active.lastError : error);
  }

  #turnError(active: ActiveTurn, error: ThreadItemError): ThreadItemError {
    const model = this.#sessions.get(conversationKey(active.projectId, active.conversationId))?.session.model;
    return normalizeAgentError(error.message, {
      ...(model ? { provider: model.provider, model: model.id, endpoint: model.baseUrl } : {}),
      ...error.diagnostics,
      ...this.options.errorDiagnostics?.(),
      ...(active.retryAttempts !== undefined ? { retryAttempts: active.retryAttempts } : {}),
    });
  }

  #markError(projectId: string, active: ActiveTurn, failure: ThreadItemError): void {
    const error = this.#turnError(active, failure);
    this.#completeOpenItems(projectId, active, "failed", error);
    this.#ensureTerminalAgentItem(projectId, active, "failed", error);
    try {
      this.#sessions.get(conversationKey(projectId, active.conversationId))?.session.sessionManager?.appendCustomEntry(AGENT_ERROR_ENTRY, {
        version: 1, error, ...(!active.userMessageStarted ? { beforeUserMessage: true } : {}),
      });
    } catch {
      console.warn("Could not save agent failure diagnostics");
    }
    this.#setState(projectId, active.conversationId, { status: "error", error: error.message });
    this.events.publish(projectId, "agent.error", { error: error.message }, eventScope(active));
    this.options.onRunFailed?.(error, { projectId, conversationId: active.conversationId, turnId: active.turnId });
  }

  #setState(projectId: string, conversationId: string, state: ConversationAgentState): void {
    this.#agentStates.set(conversationKey(projectId, conversationId), state);
  }

  isProjectBusy(projectId: string): boolean {
    const prefix = `${projectId}:`;
    return this.#puttingBack.has(projectId) || [...this.#activeTurns.keys(), ...this.#revisions].some((key) => key.startsWith(prefix));
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

/**
 * Writes again where the turns that are still part of a conversation ended,
 * as the entries it left behind said. The end of a turn is recorded when its
 * run ends, which is after a message that was queued behind it, and a late
 * end may come after the next message too. Going back to before such a
 * message would otherwise take the changes of the turn before it away.
 *
 * That a turn was undone is carried over only when the files stayed as they
 * are, as when a message is edited. A restore puts them back to where that
 * undo had not happened yet, so there the turn can be undone again. The note
 * that told the model of the undo is left behind either way.
 */
function carryTurnEnds(sessionManager: NonNullable<CodingSession["sessionManager"]>, left: readonly SessionEntry[], undone = false): void {
  const kept = sessionManager.getBranch();
  const ids = new Set(kept.map((entry) => entry.id));
  // The turns that stay are the checkpoints whose message is still there; the last checkpoint may have lost its own.
  const turns = new Set<string>();
  const ended = new Set<string>();
  let checkpoint: string | undefined;
  for (const entry of kept) {
    if (entry.type === "message" && entry.message.role === "user") {
      if (checkpoint) turns.add(checkpoint);
      checkpoint = undefined;
    } else if (entry.type === "custom" && entry.customType === CHECKPOINT_ENTRY) {
      checkpoint = entry.id;
    } else if (entry.type === "custom" && entry.customType === TURN_END_ENTRY) {
      const end = parseStoredTurnEnd(entry.data);
      if (end) ended.add(end.checkpoint);
    }
  }
  for (const entry of left) {
    if (entry.type !== "custom" || entry.customType !== TURN_END_ENTRY || ids.has(entry.id)) continue;
    const end = parseStoredTurnEnd(entry.data);
    if (!end || !turns.has(end.checkpoint) || ended.has(end.checkpoint)) continue;
    sessionManager.appendCustomEntry(TURN_END_ENTRY, end);
    ended.add(end.checkpoint);
  }
  if (!undone) return;
  // The last undo of a turn says how it stands, and is read after the end of that turn.
  const last = new Map<string, StoredCheckpointUndone>();
  for (const entry of left) {
    if (entry.type !== "custom" || entry.customType !== CHECKPOINT_UNDONE_ENTRY || ids.has(entry.id)) continue;
    const stored = parseStoredCheckpointUndone(entry.data);
    if (stored && turns.has(stored.checkpoint) && ended.has(stored.checkpoint)) last.set(stored.checkpoint, stored);
  }
  for (const stored of last.values()) sessionManager.appendCustomEntry(CHECKPOINT_UNDONE_ENTRY, stored);
}

const REFERENCE_MARKER = "<workspace-file-references>";
const LOCAL_ATTACHMENTS_MARKER = "<local-attachments>";
const USER_PROMPT_ENTRY = "ohmygame-user-prompt";
/** What is answered to a message, an edit, a restore or an undo that comes while the project's files are being put back. */
const PUTTING_BACK = "Wait until the project's files have been put back";
// How long the end of a run waits for its cleanup and for the snapshot that closes it. A snapshot reads only what
// changed since the one before it, some 60 MB a second on a laptop disk, so this is time for a turn that wrote more
// than a gigabyte. The turn is then closed without an end, and gets one later if the snapshot does come back.
const CLOSING_MS = 30_000;
/** What `within` gives when the work has not come back in time. */
const TOO_LONG = Symbol("too long");

/** Gives what the work gives, or `TOO_LONG` when it has not come back after `ms`. The work itself goes on. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TOO_LONG> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<typeof TOO_LONG>((resolve) => { timer = setTimeout(() => resolve(TOO_LONG), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

interface StoredPromptDetails {
  version: 1;
  wirePromptHash: string;
  prompt: string;
  mentions: PluginMention[];
  references: PromptReference[];
  attachments: ConversationAttachment[];
  attachmentContext: string;
}

function promptWithReferences(prompt: string, references: PromptReference[]): string {
  if (references.length === 0) return prompt;
  return `${prompt}\n\n${REFERENCE_MARKER}\n${JSON.stringify(references.map(({ path }) => path))}\n</workspace-file-references>`;
}

export function skillInvocationPrompt(prompt: string): string {
  const match = prompt.match(/^\$([a-zA-Z0-9][a-zA-Z0-9._-]*)(?=\s|$)/);
  return match ? `/skill:${match[1]}${prompt.slice(match[0].length)}` : prompt;
}

function parseUserPrompt(value: string): { text: string; mentions: PluginMention[]; references: PromptReference[]; attachments: ConversationAttachment[]; attachmentContext: string } {
  const editorContext = splitPromptContext(value);
  const localAttachments = parseLocalAttachments(editorContext.rest);
  const source = localAttachments ? localAttachments.visible : editorContext.rest;
  const attachmentContext = `${localAttachments?.context ?? ""}${editorContext.block}`;
  const marker = `\n\n${REFERENCE_MARKER}\n`;
  const index = source.lastIndexOf(marker);
  const visible = index < 0 ? source : source.slice(0, index);
  const skill = parseSkillBlock(visible);
  const restored = skill ? `$${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}` : visible;
  const parsed = parsePluginMentions(restored);
  const text = parsed.text;
  const attachments = localAttachments?.attachments ?? [];
  if (index < 0) return { text, mentions: parsed.mentions, references: [], attachments, attachmentContext };
  const closing = "\n</workspace-file-references>";
  const encoded = source.slice(index + marker.length, source.endsWith(closing) ? -closing.length : undefined);
  try {
    const paths: unknown = JSON.parse(encoded);
    return {
      text,
      mentions: parsed.mentions,
      references: Array.isArray(paths)
        ? paths.filter((item): item is string => typeof item === "string").map((path) => ({ type: "workspace-file", path }))
        : [],
      attachments,
      attachmentContext,
    };
  } catch {
    return { text, mentions: parsed.mentions, references: [], attachments, attachmentContext };
  }
}

function parseLocalAttachments(value: string): { visible: string; attachments: ConversationAttachment[]; context: string } | undefined {
  const marker = `\n\n${LOCAL_ATTACHMENTS_MARKER}\n`;
  const index = value.lastIndexOf(marker);
  if (index >= 0) {
    const closing = "\n</local-attachments>";
    const closingIndex = value.indexOf(closing, index + marker.length);
    if (closingIndex >= 0) {
      const encoded = value.slice(index + marker.length, closingIndex);
      try {
        const parsed: unknown = JSON.parse(encoded);
        const files = parsed && typeof parsed === "object" ? (parsed as { files?: unknown }).files : undefined;
        if (Array.isArray(files)) {
          return { visible: `${value.slice(0, index)}${value.slice(closingIndex + closing.length)}`, attachments: files.filter(isConversationAttachment), context: value.slice(index, closingIndex + closing.length) };
        }
      } catch {
        // Keep an unparseable private context out of the user-visible message.
      }
      return { visible: `${value.slice(0, index)}${value.slice(closingIndex + closing.length)}`, attachments: [], context: value.slice(index, closingIndex + closing.length) };
    }
  }
  return parseLegacyLocalAttachments(value);
}

function parseLegacyLocalAttachments(value: string): { visible: string; attachments: ConversationAttachment[]; context: string } | undefined {
  const marker = "\n\n[Attached local files]\n";
  const index = value.lastIndexOf(marker);
  if (index < 0) return undefined;
  const attachments = value.slice(index + marker.length)
    .split("\n")
    .flatMap((line) => legacyAttachment(line));
  return { visible: value.slice(0, index), attachments, context: value.slice(index) };
}

function legacyAttachment(line: string): ConversationAttachment[] {
  const match = line.match(/^- (.+) \((image|text|document|audio|video|model|archive|binary), ([\d.]+) (B|KB|MB)\): /);
  if (!match) return [];
  const [, rawRelativePath, kind, amount, unit] = match;
  const relativePath = rawRelativePath.replaceAll("\\_", "_");
  const multiplier = unit === "MB" ? 1024 * 1024 : unit === "KB" ? 1024 : 1;
  const size = Number(amount) * multiplier;
  if (!Number.isFinite(size)) return [];
  return [{ name: path.posix.basename(relativePath), relativePath, kind: kind as ConversationAttachment["kind"], size }];
}

function isConversationAttachment(value: unknown): value is ConversationAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Partial<ConversationAttachment>;
  return typeof attachment.name === "string"
    && typeof attachment.relativePath === "string"
    && typeof attachment.size === "number"
    && (attachment.kind === "image" || attachment.kind === "text" || attachment.kind === "document" || attachment.kind === "audio" || attachment.kind === "video" || attachment.kind === "model" || attachment.kind === "archive" || attachment.kind === "binary")
    && (attachment.mediaType === undefined || typeof attachment.mediaType === "string");
}

function parseStoredPromptDetails(value: unknown): StoredPromptDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<StoredPromptDetails>;
  if (details.version !== 1 || typeof details.wirePromptHash !== "string" || typeof details.prompt !== "string" || typeof details.attachmentContext !== "string") return undefined;
  if (!Array.isArray(details.mentions) || !details.mentions.every(isPluginMention)) return undefined;
  if (!Array.isArray(details.references) || !details.references.every(isPromptReference)) return undefined;
  if (!Array.isArray(details.attachments) || !details.attachments.every(isConversationAttachment)) return undefined;
  return details as StoredPromptDetails;
}

function isPluginMention(value: unknown): value is PluginMention {
  if (!value || typeof value !== "object") return false;
  const mention = value as Partial<PluginMention>;
  return typeof mention.name === "string" && typeof mention.displayName === "string" && typeof mention.marketplaceId === "string";
}

function isPromptReference(value: unknown): value is PromptReference {
  if (!value || typeof value !== "object") return false;
  const reference = value as Partial<PromptReference>;
  return reference.type === "workspace-file" && typeof reference.path === "string";
}

function lastUserPrompt(project: ProjectState, sessionPath: string): {
  id: string;
  mentions: PluginMention[];
  references: PromptReference[];
  images: PromptImage[];
  attachments: ConversationAttachment[];
  attachmentContext: string;
} | undefined {
  const entries = SessionManager.open(sessionPath, sessionDirectory(project), project.workspacePath).getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const parsed = parseUserPrompt(textContent(entry.message.content));
    const details = storedPromptBefore(entries, index, textContent(entry.message.content));
    return {
      id: entry.id,
      mentions: details?.mentions ?? parsed.mentions,
      references: details?.references ?? parsed.references,
      images: imageContent(entry.message.content),
      attachments: details?.attachments ?? parsed.attachments,
      attachmentContext: details?.attachmentContext ?? parsed.attachmentContext,
    };
  }
  return undefined;
}

function storedPromptBefore(entries: readonly SessionEntry[], userIndex: number, wirePrompt: string): StoredPromptDetails | undefined {
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "user") return undefined;
    if (entry.type !== "custom" || entry.customType !== USER_PROMPT_ENTRY) continue;
    const details = parseStoredPromptDetails(entry.data);
    return details?.wirePromptHash === promptHash(wirePrompt) ? details : undefined;
  }
  return undefined;
}

function sessionDirectory(project: ProjectState): string {
  return path.join(project.storagePath ?? path.dirname(project.workspacePath), "session");
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
    const url = (item as { url?: unknown }).url;
    return [{ mediaType, data, ...(typeof url === "string" ? { url } : {}) }];
  });
}

function isPromptImageMediaType(value: unknown): value is PromptImage["mediaType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function toPiImage(image: PromptImage): PiPromptImage {
  return { type: "image", mimeType: image.mediaType, data: image.data };
}

type StoredPromptSource = Pick<ActiveTurn, "prompt" | "mentions" | "references" | "attachments" | "attachmentContext">;

function appendPromptDetails(sessionManager: CodingSession["sessionManager"], value: StoredPromptSource, wirePrompt: string): void {
  if (!sessionManager || (value.references.length === 0 && value.attachments.length === 0 && !value.attachmentContext.trim())) return;
  const details: StoredPromptDetails = {
    version: 1,
    wirePromptHash: promptHash(wirePrompt),
    prompt: value.prompt,
    mentions: value.mentions,
    references: value.references,
    attachments: value.attachments,
    attachmentContext: value.attachmentContext,
  };
  sessionManager.appendCustomEntry(USER_PROMPT_ENTRY, details);
}

function promptHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function toolOutput(result: unknown): Pick<
  Extract<ThreadItem, { type: "dynamicToolCall" }>,
  "output" | "truncated" | "artifact" | "images" | "webSearch" | "lineChanges" | "fileDiff"
> {
  const details = record(record(result)?.details);
  const artifact = toolArtifact(result);
  const webSearch = toolWebSearch(result);
  const images = result && typeof result === "object" && "content" in result
    ? imageContent((result as { content?: unknown }).content)
    : [];
  const media = {
    ...fileChangeMetadata(details),
    ...(artifact ? { artifact } : {}),
    ...(images.length ? { images } : {}),
    ...(webSearch ? { webSearch } : {}),
  };
  const value = result && typeof result === "object" && "content" in result
    ? textContent((result as { content?: unknown }).content)
    : stringify(result);
  if (!value) return media;
  if (value.length <= MAX_TOOL_OUTPUT) return { output: value, ...media };
  const half = MAX_TOOL_OUTPUT / 2;
  return {
    output: `${value.slice(0, half)}\n\n... output truncated ...\n\n${value.slice(-half)}`,
    truncated: true,
    ...media,
  };
}

function toolWebSearch(result: unknown): Extract<ThreadItem, { type: "dynamicToolCall" }>["webSearch"] {
  const details = result && typeof result === "object" && "details" in result ? (result as { details?: unknown }).details : undefined;
  const value = details && typeof details === "object" && "webSearch" in details ? (details as { webSearch?: unknown }).webSearch : undefined;
  if (!value || typeof value !== "object") return undefined;
  const metadata = value as { provider?: unknown; providerName?: unknown; fallbackFrom?: unknown };
  if ((metadata.provider !== "exa" && metadata.provider !== "parallel" && metadata.provider !== "custom") || typeof metadata.providerName !== "string") return undefined;
  const fallbackFrom = metadata.fallbackFrom;
  return { provider: metadata.provider, providerName: metadata.providerName, ...(fallbackFrom === "exa" || fallbackFrom === "parallel" || fallbackFrom === "custom" ? { fallbackFrom } : {}) };
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

const assistantThinkingSanitizerExtension: ExtensionFactory = (pi) => {
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const message = normalizeAssistantMessage(event.message);
    return message === event.message ? undefined : { message };
  });
};

export async function createPiSession(
  project: Pick<ProjectState, "workspacePath"> & Partial<Pick<ProjectState, "storagePath">> & AgentPromptProject,
  sessionManager: SessionManager,
  customTools: ToolDefinition[] = [],
  modelRuntime?: ModelRuntime,
  model?: RuntimeModel,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.resolve(process.cwd(), ".data", "pi-agent"),
  resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>,
  mcp?: { factory: ExtensionFactory; host: PluginMcpHost },
  responsesTransport?: (provider: string) => ResponsesTransportMode,
  snapshotBeforeMessage?: () => Promise<string>,
): Promise<CodingSession> {
  let checkpointFailure: { cause: unknown } | undefined;
  let stopForCheckpointFailure: () => void = () => {};
  const failCheckpoint = (cause: unknown) => {
    checkpointFailure ??= { cause };
    stopForCheckpointFailure();
  };
  const assertCheckpoint = () => {
    if (checkpointFailure) throw checkpointFailure.cause;
  };
  const guardedCheckpoints: ExtensionFactory = async (pi) => {
    pi.on("before_agent_start", async (event) => {
      try {
        const notice = await readWorkspaceNotice(project);
        return notice ? { systemPrompt: `${event.systemPrompt}\n\nWorkspace restore notice (inspect current files before continuing):\n${notice}` } : undefined;
      } catch (cause) { failCheckpoint(cause); }
    });
    pi.on("tool_call", () => checkpointFailure
      ? { block: true, reason: "Workspace checkpoint failed; no tools may run." } : undefined);
    if (snapshotBeforeMessage) await checkpointExtension(async () => {
      if (checkpointFailure) throw checkpointFailure.cause;
      return snapshotBeforeMessage();
    }, failCheckpoint)(pi);
  };
  // Trusted-local phase: cwd guides Pi but is not an OS security boundary.
  const { resourceLoader, sessionSettings, pluginSkills } = await createPiResourceLoader(project.workspacePath, agentDir, {
    resolvePluginSkills,
    appendSystemPrompt: appendSystemPromptForProject(project),
    mcpFactory: mcp?.factory,
    checkpointFactory: guardedCheckpoints,
  });
  const images = new SessionImages(sessionManager, path.join(agentDir, "request-image-previews"));
  const { session } = await createAgentSession({
    cwd: project.workspacePath,
    agentDir,
    customTools: [createTrackedWriteTool(project.workspacePath) as ToolDefinition, createProviderImageReadTool(project.workspacePath, sessionSettings) as ToolDefinition, createBashToolDefinition(project.workspacePath, {
      shellPath: sessionSettings.getShellPath(),
      commandPrefix: sessionSettings.getShellCommandPrefix(),
      spawnHook: (context) => ({ ...context, env: projectProcessEnvironment(context.env) }),
    }) as ToolDefinition, images.recallTool as ToolDefinition, ...customTools],
    model: model ? compatibleRuntimeModel(model) : undefined,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager: sessionSettings,
  });
  stopForCheckpointFailure = () => { void session.abort().catch(() => {}); };
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (...args) => {
    // Pi swallows extension exceptions and may call a provider with an aborted signal.
    assertCheckpoint();
    return streamFunction(...args);
  };
  const convertToLlm = session.agent.convertToLlm;
  session.agent.convertToLlm = async (messages) => {
    const converted = await convertToLlm(messages);
    return converted.map((message) => message.role === "assistant" ? normalizeAssistantMessage(message) : message);
  };
  installDeepSeekImageFiles(session, agentDir);
  installSessionImageRequests(session, images, agentDir, { transportMode: responsesTransport });
  mcp?.host.manage(session);
  try { await session.bindExtensions({ mode: "rpc" }); } catch (cause) { session.dispose(); throw cause; }
  const prompt = session.prompt.bind(session);
  return Object.assign(session, {
    emitsInitialUserMessage: true,
    prompt: async (...args: Parameters<typeof prompt>) => {
      checkpointFailure = undefined;
      await prompt(...args);
      assertCheckpoint();
    },
    getSkills: () => skillCatalog(resourceLoader.getSkills().skills, pluginSkills),
  });
}

export async function loadPiSkills(
  workspacePath: string,
  agentDir = process.env.PI_CODING_AGENT_DIR ?? path.resolve(process.cwd(), ".data", "pi-agent"),
  resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>,
): Promise<SkillCatalogItem[]> {
  const { resourceLoader, pluginSkills } = await createPiResourceLoader(workspacePath, agentDir, { resolvePluginSkills });
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
  options: {
    resolvePluginSkills?: () => Promise<PluginSkillRegistration[]>;
    appendSystemPrompt?: readonly string[];
    mcpFactory?: ExtensionFactory;
    checkpointFactory?: ExtensionFactory;
  } = {},
): Promise<{ resourceLoader: DefaultResourceLoader; sessionSettings: SettingsManager; pluginSkills: PluginSkillRegistration[] }> {
  await ensureOhMyGamePiEnvironment(agentDir);
  const persistedSettings = SettingsManager.create(workspacePath, agentDir);
  const sessionSettings = SettingsManager.inMemory(persistedSettings.getGlobalSettings());
  sessionSettings.applyOverrides(persistedSettings.getProjectSettings());
  sessionSettings.setPackages(withoutOhMyGameManagedPiPackages(sessionSettings.getPackages()).filter(entry => {
    const source = typeof entry === "string" ? entry : entry.source;
    return !source.replace(/\\/g, "/").endsWith("/pi-mcp-adapter");
  }));
  const pluginSkills = await options.resolvePluginSkills?.() ?? [];
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspacePath,
    agentDir,
    settingsManager: sessionSettings,
    extensionFactories: [{ name: "openrouter-attribution", factory: openRouterAttributionExtension, hidden: true },
      { name: "assistant-thinking-sanitizer", factory: assistantThinkingSanitizerExtension, hidden: true },
      ...(options.checkpointFactory ? [{ name: "checkpoints", factory: options.checkpointFactory, hidden: true }] : []),
      ...(options.mcpFactory ? [{ name: "plugin-mcp", factory: options.mcpFactory, hidden: true }] : [])],
    additionalSkillPaths: pluginSkills.map((skill) => skill.path),
    appendSystemPrompt: options.appendSystemPrompt
      ? [...options.appendSystemPrompt]
      : [],
    agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: projectContextFiles(agentsFiles, workspacePath, agentDir) }),
  });
  await resourceLoader.reload();
  return { resourceLoader, sessionSettings, pluginSkills };
}

/**
 * Pi also loads AGENTS.md and CLAUDE.md from every ancestor of the workspace.
 * Those describe whatever repository or folder happens to contain the game
 * (in development, this repository), so only the workspace's own files and
 * OhMyGame's agent directory count.
 */
export function projectContextFiles<File extends { path: string }>(files: readonly File[], workspacePath: string, agentDir: string): File[] {
  const roots = [path.resolve(workspacePath), path.resolve(agentDir)];
  return files.filter((file) => {
    const resolved = path.resolve(file.path);
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  });
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

export function lastAssistantError(messages: readonly unknown[]): ThreadItemError | undefined {
  const message = messages.findLast(isAssistantMessage);
  return message?.stopReason === "error" ? assistantMessageError(message) : undefined;
}
