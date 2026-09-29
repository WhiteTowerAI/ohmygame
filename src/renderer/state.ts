import type { ConversationAgentSettings, ConversationAgentState, ConversationDetail, ConversationSummary, PendingPrompt, PlanSessionState, ProjectState, PromptContextLabel, RuntimeEvent, ThreadItem, Turn, TurnStatus } from "../shared/contracts.js";
import { finalizeTurnItems } from "../shared/turns.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface RendererState {
  phase: "loading" | "ready" | "fatal";
  connection: ConnectionStatus;
  project?: ProjectState;
  conversation?: ConversationSummary;
  agent: ConversationAgentState;
  settings: ConversationAgentSettings;
  plan: PlanSessionState;
  turns: Turn[];
  pendingPrompts: PendingPrompt[];
  lastEventId: number;
  notice?: string;
}

export type RendererAction =
  | { type: "initialized"; project: ProjectState; detail: ConversationDetail }
  | { type: "project-updated"; project: ProjectState }
  | { type: "conversation-loaded"; detail: ConversationDetail }
  | { type: "runtime-event"; event: RuntimeEvent }
  | { type: "conversation-settings"; settings: ConversationAgentSettings }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "notice"; message?: string }
  | { type: "fatal"; message: string };

export const initialRendererState: RendererState = {
  phase: "loading",
  connection: "connecting",
  agent: { status: "idle" },
  settings: {},
  plan: { mode: "normal" },
  turns: [],
  pendingPrompts: [],
  lastEventId: 0,
};

export function rendererReducer(state: RendererState, action: RendererAction): RendererState {
  if (action.type === "conversation-loaded" || action.type === "initialized") {
    const detail = action.detail;
    const steering = detail.pendingPrompts.filter((item) => item.steering);
    return {
      ...state,
      phase: "ready",
      ...(action.type === "initialized" ? { project: action.project } : {}),
      conversation: detail.conversation,
      agent: detail.agent,
      settings: detail.settings,
      plan: detail.plan,
      turns: appendSteeringTurns(detail.turns, detail.conversation.id, steering),
      pendingPrompts: detail.pendingPrompts.filter((item) => !item.steering),
      notice: undefined,
      lastEventId: detail.cursor,
    };
  }
  if (action.type === "project-updated") return { ...state, project: action.project };
  if (action.type === "connection") return { ...state, connection: action.status };
  if (action.type === "conversation-settings") return { ...state, settings: action.settings };
  if (action.type === "notice") return { ...state, notice: action.message };
  if (action.type === "fatal") return { ...state, phase: "fatal", notice: action.message };
  if (action.event.id <= state.lastEventId) return state;
  return reduceRuntimeEvent(state, action.event);
}

export function reduceRuntimeEvent(state: RendererState, event: RuntimeEvent): RendererState {
  const next = { ...state, lastEventId: event.id, notice: undefined };
  const project = state.project;
  const conversation = state.conversation;
  const conversationScopedEvent = event.type.startsWith("agent.") || event.type.startsWith("item.") || event.type.startsWith("plan.") || event.type.startsWith("prompt.") || event.type === "conversation.model.changed";
  if (conversationScopedEvent && (!conversation || event.conversationId !== conversation.id)) return next;

  switch (event.type) {
    case "conversation.renamed":
      return conversation?.id === event.data.conversation.id
        ? { ...next, conversation: event.data.conversation }
        : next;
    case "conversation.model.changed":
      if (!conversation) return next;
      return {
        ...next,
        turns: [...state.turns, {
          id: event.data.item.turnId,
          conversationId: conversation.id,
          status: "completed",
          items: [{ ...event.data.item, timestamp: eventTime(event) }],
        }],
      };
    case "project.renamed":
      return project?.id === event.data.project.id
        ? { ...next, project: event.data.project }
        : next;
    case "preview.starting":
      return project ? { ...next, project: { ...project, preview: { status: "starting" } } } : next;
    case "preview.ready":
      return project ? { ...next, project: { ...project, preview: { status: "ready", url: event.data.url } } } : next;
    case "preview.error":
      return project ? { ...next, project: { ...project, preview: { status: "error", error: event.data.error } } } : next;
    case "preview.stopped":
      return project ? { ...next, project: { ...project, preview: { status: "stopped" } } } : next;
    case "agent.started": {
      if (!event.turnId || !conversation) return next;
      const replacementId = event.data.revision === "last-turn"
        ? state.turns.findLast((turn) => turn.items.some((item) => item.type === "userMessage"))?.id
        : undefined;
      const turn = promptTurn(conversation.id, event.turnId, event.data, "inProgress", eventTime(event));
      const previousTurns = state.turns.map((item) => item.status === "inProgress" && item.id !== event.turnId
        ? { ...item, status: "completed" as const, items: finalizeTurnItems(item.items, "completed") }
        : item);
      const retainedTurns = previousTurns.filter((item) => item.id !== replacementId);
      const replacesSteeringTurn = retainedTurns.some((item) => item.id === turn.id);
      return {
        ...next,
        agent: { status: "running" },
        pendingPrompts: state.pendingPrompts.filter((item) => item.turnId !== event.turnId),
        turns: replacesSteeringTurn
          ? retainedTurns.map((item) => item.id === turn.id ? turn : item)
          : [...retainedTurns, turn],
      };
    }
    case "prompt.queued":
      if (!event.turnId) return next;
      return { ...next, pendingPrompts: [...state.pendingPrompts, { turnId: event.turnId, prompt: event.data.prompt, mentions: event.data.mentions ?? [], references: event.data.references, images: event.data.images ?? [], attachments: event.data.attachments ?? [] }] };
    case "prompt.steered":
      if (!event.turnId || !conversation) return next;
      return {
        ...next,
        pendingPrompts: state.pendingPrompts.filter((item) => item.turnId !== event.turnId),
        turns: [
          ...state.turns.filter((turn) => turn.id !== event.turnId),
          promptTurn(conversation.id, event.turnId, event.data, "completed", eventTime(event), true),
        ],
      };
    case "prompt.removed":
      return {
        ...next,
        pendingPrompts: state.pendingPrompts.filter((item) => item.turnId !== event.turnId),
        turns: state.turns.filter((turn) => turn.id !== event.turnId || !turn.steering),
      };
    case "item.started":
    case "item.updated": {
      if (!conversation) return next;
      const item = { ...event.data.item, timestamp: eventTime(event) };
      const result = upsertTurnItem(next, conversation.id, item.turnId, item);
      return item.type === "contextCompaction" ? { ...result, agent: { status: "running" } } : result;
    }
    case "item.reasoning.textDelta":
      return updateTurnItem(next, event.data.itemId, (item) => item.type === "reasoning" ? { ...item, text: item.text + event.data.delta } : item);
    case "item.agentMessage.delta":
      return updateTurnItem(next, event.data.itemId, (item) => item.type === "agentMessage" ? { ...item, text: item.text + event.data.delta, timestamp: eventTime(event) } : item);
    case "item.completed": {
      if (!conversation) return next;
      const item = { ...event.data.item, timestamp: eventTime(event) };
      const result = shouldRemoveCompletedItem(item)
        ? removeTurnItem(next, item.id)
        : upsertTurnItem(next, conversation.id, item.turnId, item);
      return {
        ...result,
        ...(item.type === "plan" ? { plan: { ...state.plan, plan: item.plan } } : {}),
      };
    }
    case "plan.mode.changed":
      return { ...next, plan: event.data };
    case "agent.completed":
      return finishAgent(next, event.turnId, "completed");
    case "agent.cancelled":
      return finishAgent(next, event.turnId, "cancelled");
    case "agent.error":
      return finishAgent(next, event.turnId, "failed", event.data.error);
    case "publish.completed":
      return project ? { ...next, project: { ...project, publication: { gameId: event.data.game.id, deploymentId: event.data.game.deploymentId, playUrl: event.data.game.playUrl, publishedAt: event.data.game.publishedAt, title: event.data.game.title, description: event.data.game.description } } } : next;
    case "publish.error":
      return { ...next, notice: event.data.error };
    case "publish.started":
      return next;
    default:
      return next;
  }
}

function finishAgent(state: RendererState, turnId: string | undefined, status: TurnStatus, error?: string): RendererState {
  return {
    ...state,
    turns: turnId ? updateTurn(state.turns, turnId, (turn) => ({ ...turn, status, items: finalizeTurnItems(turn.items, status) })) : state.turns,
    agent: status === "failed" ? { status: "error", ...(error ? { error } : {}) } : { status: "idle" },
  };
}

function appendSteeringTurns(turns: Turn[], conversationId: string, prompts: PendingPrompt[]): Turn[] {
  return prompts.reduce((current, prompt) => current.some((turn) => turn.id === prompt.turnId)
    ? current
    : [...current, promptTurn(conversationId, prompt.turnId, prompt, "completed", undefined, true)], turns);
}

function promptTurn(
  conversationId: string,
  turnId: string,
  prompt: Pick<PendingPrompt, "prompt" | "mentions" | "images" | "attachments"> | {
    prompt: string;
    mentions?: PendingPrompt["mentions"];
    images?: PendingPrompt["images"];
    attachments?: PendingPrompt["attachments"];
    contexts?: PromptContextLabel[];
  },
  status: TurnStatus,
  timestamp?: number,
  steering = false,
): Turn {
  const mentions = prompt.mentions ?? [];
  const images = prompt.images ?? [];
  const attachments = prompt.attachments ?? [];
  const contexts = "contexts" in prompt ? prompt.contexts ?? [] : [];
  return {
    id: turnId,
    conversationId,
    status,
    ...(steering ? { steering: true } : {}),
    items: [{
      id: `${turnId}:user`,
      turnId,
      type: "userMessage",
      text: prompt.prompt,
      ...(mentions.length ? { mentions } : {}),
      ...(images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(contexts.length ? { contexts } : {}),
      ...(timestamp === undefined ? {} : { timestamp }),
    }, ...(images.length ? [{
      id: `${turnId}:images`,
      turnId,
      type: "imageRead" as const,
      count: images.length,
      status: "completed" as const,
      ...(timestamp === undefined ? {} : { timestamp }),
    }] : [])],
  };
}

function eventTime(event: RuntimeEvent): number | undefined {
  const value = Date.parse(event.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function upsertTurnItem(state: RendererState, conversationId: string, turnId: string, incoming: ThreadItem): RendererState {
  const existing = state.turns.find((turn) => turn.id === turnId);
  if (!existing) return { ...state, turns: [...state.turns, { id: turnId, conversationId, status: "inProgress", items: [incoming] }] };
  return { ...state, turns: updateTurn(state.turns, turnId, (turn) => ({ ...turn, items: upsertItem(turn.items, incoming) })) };
}

function updateTurnItem(state: RendererState, id: string, update: (item: ThreadItem) => ThreadItem): RendererState {
  return { ...state, turns: state.turns.map((turn) => ({ ...turn, items: turn.items.map((item) => item.id === id ? update(item) : item) })) };
}

function removeTurnItem(state: RendererState, id: string): RendererState {
  return { ...state, turns: state.turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => item.id !== id) })) };
}

function shouldRemoveCompletedItem(item: ThreadItem): boolean {
  if (item.type === "retry") return item.status === "completed";
  return (item.type === "agentMessage" || item.type === "reasoning") && item.status === "completed" && !item.text;
}

function updateTurn(turns: Turn[], id: string, update: (turn: Turn) => Turn): Turn[] {
  return turns.map((turn) => turn.id === id ? update(turn) : turn);
}

function upsertItem(items: ThreadItem[], incoming: ThreadItem): ThreadItem[] {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...items, incoming];
  return items.map((item, itemIndex) => itemIndex === index ? incoming : item);
}
