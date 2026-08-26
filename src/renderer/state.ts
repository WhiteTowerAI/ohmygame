import type { ActiveTurnState, ConversationAgentSettings, ConversationState, PendingPrompt, ProjectState, QuestionnaireRequest, RuntimeEvent, ThreadItem } from "../shared/contracts.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export interface RendererState {
  phase: "loading" | "ready" | "fatal";
  connection: ConnectionStatus;
  project?: ProjectState;
  conversation?: ConversationState;
  activeTurn?: ActiveTurnState;
  pendingPrompts: PendingPrompt[];
  questionnaire?: QuestionnaireRequest;
  items: ThreadItem[];
  lastEventId: number;
  notice?: string;
}

export type RendererAction =
  | { type: "initialized"; project: ProjectState; conversation: ConversationState; items?: ThreadItem[]; activeTurn?: ActiveTurnState; pendingPrompts?: PendingPrompt[]; questionnaire?: QuestionnaireRequest; cursor: number }
  | { type: "conversation-loaded"; conversation: ConversationState; items: ThreadItem[]; activeTurn?: ActiveTurnState; pendingPrompts?: PendingPrompt[]; questionnaire?: QuestionnaireRequest; cursor: number }
  | { type: "runtime-event"; event: RuntimeEvent }
  | { type: "conversation-settings"; settings: ConversationAgentSettings }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "notice"; message?: string }
  | { type: "fatal"; message: string };

export const initialRendererState: RendererState = {
  phase: "loading",
  connection: "connecting",
  items: [],
  pendingPrompts: [],
  lastEventId: 0,
};

export function rendererReducer(state: RendererState, action: RendererAction): RendererState {
  if (action.type === "conversation-loaded") {
    return {
      ...state,
      phase: "ready",
      conversation: action.conversation,
      activeTurn: action.activeTurn,
      pendingPrompts: action.pendingPrompts ?? [],
      questionnaire: action.questionnaire,
      items: action.items,
      notice: undefined,
      lastEventId: action.cursor,
    };
  }
  if (action.type === "initialized") {
    return {
      ...state,
      phase: "ready",
      project: action.project,
      conversation: action.conversation,
      activeTurn: action.activeTurn,
      pendingPrompts: action.pendingPrompts ?? [],
      questionnaire: action.questionnaire,
      items: action.items ?? state.items,
      lastEventId: action.cursor,
    };
  }
  if (action.type === "connection") return { ...state, connection: action.status };
  if (action.type === "conversation-settings") {
    return state.conversation ? { ...state, conversation: { ...state.conversation, ...action.settings } } : state;
  }
  if (action.type === "notice") return { ...state, notice: action.message };
  if (action.type === "fatal") return { ...state, phase: "fatal", notice: action.message };
  if (action.event.id <= state.lastEventId) return state;
  return reduceRuntimeEvent(state, action.event);
}

export function reduceRuntimeEvent(state: RendererState, event: RuntimeEvent): RendererState {
  const next = { ...state, lastEventId: event.id, notice: undefined };
  const project = state.project;
  const conversation = state.conversation;
  const agentEvent = event.type.startsWith("agent.") || event.type.startsWith("item.") || event.type.startsWith("plan.") || event.type.startsWith("prompt.") || event.type.startsWith("questionnaire.");
  let scoped = next;

  if (event.type === "agent.started" && conversation && event.conversationId === conversation.id && event.turnId) {
    scoped = { ...scoped, activeTurn: { conversationId: conversation.id, turnId: event.turnId } };
  } else if (
    (event.type === "agent.completed" || event.type === "agent.cancelled" || event.type === "agent.error") &&
    event.conversationId === conversation?.id && state.activeTurn?.turnId === event.turnId
  ) {
    scoped = { ...scoped, activeTurn: undefined };
  }

  if (agentEvent && (!conversation || event.conversationId !== conversation.id)) return next;

  switch (event.type) {
    case "preview.starting":
      return project ? { ...scoped, project: { ...project, preview: { status: "starting" } } } : scoped;
    case "preview.ready":
      return project ? { ...scoped, project: { ...project, preview: { status: "ready", url: event.data.url } } } : scoped;
    case "preview.error":
      return project ? { ...scoped, project: { ...project, preview: { status: "error", error: event.data.error } } } : scoped;
    case "preview.stopped":
      return project ? { ...scoped, project: { ...project, preview: { status: "stopped" } } } : scoped;
    case "agent.started": {
      if (!event.turnId) return scoped;
      const replacedTurnId = event.data.revision === "last-turn"
        ? [...state.items].reverse().find((item) => item.type === "userMessage")?.turnId
        : undefined;
      return {
        ...scoped,
        conversation: conversation ? { ...conversation, agent: { status: "running", turnId: event.turnId } } : conversation,
        pendingPrompts: state.pendingPrompts.filter((item) => item.turnId !== event.turnId),
        items: [
          ...state.items.filter((item) => item.turnId !== replacedTurnId),
          { id: `${event.turnId}:user`, turnId: event.turnId, type: "userMessage", text: event.data.prompt, ...(event.data.images?.length ? { images: event.data.images } : {}), timestamp: eventTime(event) },
        ],
      };
    }
    case "prompt.queued":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        pendingPrompts: [
          ...state.pendingPrompts,
          { turnId: event.turnId, prompt: event.data.prompt, references: event.data.references, images: event.data.images ?? [] },
        ],
      };
    case "prompt.removed":
      return { ...scoped, pendingPrompts: state.pendingPrompts.filter((item) => item.turnId !== event.turnId) };
    case "agent.retrying": {
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        items: upsertItem(state.items, {
          id: `${event.turnId}:retry:${event.data.attempt}`,
          turnId: event.turnId,
          type: "retry",
          timestamp: eventTime(event),
          ...event.data,
        }),
      };
    }
    case "item.started":
    case "item.updated": {
      const item = { ...event.data.item, timestamp: eventTime(event) };
      const manualCompaction = item.type === "contextCompaction" && !state.activeTurn;
      return {
        ...scoped,
        ...(manualCompaction && conversation ? {
          activeTurn: { conversationId: conversation.id, turnId: item.turnId },
          conversation: { ...conversation, agent: { status: "running", turnId: item.turnId } },
        } : {}),
        items: upsertItem(state.items, item),
      };
    }
    case "item.reasoning.textDelta":
      return {
        ...scoped,
        items: updateItem(state.items, event.data.itemId, (item) => item.type === "reasoning"
          ? { ...item, text: item.text + event.data.delta }
          : item),
      };
    case "item.agentMessage.delta":
      return {
        ...scoped,
        items: updateItem(state.items, event.data.itemId, (item) => item.type === "agentMessage"
          ? { ...item, text: item.text + event.data.delta, timestamp: eventTime(event) }
          : item),
      };
    case "item.completed": {
      const item = { ...event.data.item, timestamp: eventTime(event) };
      const manualCompaction = item.type === "contextCompaction" &&
        !state.items.some((candidate) => candidate.turnId === item.turnId && candidate.type === "userMessage");
      const items = ((item.type === "agentMessage" || item.type === "reasoning") && item.status === "completed" && !item.text)
        ? state.items.filter((candidate) => candidate.id !== item.id)
        : upsertItem(state.items, item);
      return {
        ...scoped,
        ...(manualCompaction && conversation ? {
          activeTurn: scoped.activeTurn?.turnId === item.turnId ? undefined : scoped.activeTurn,
          conversation: { ...conversation, agent: { status: item.status === "failed" ? "error" : "idle" } },
        } : {}),
        ...(item.type === "plan" && conversation ? { conversation: { ...conversation, plan: item.plan } } : {}),
        items,
      };
    }
    case "plan.mode.changed":
      return {
        ...scoped,
        conversation: conversation ? {
          ...conversation,
          planMode: event.data.mode,
          plan: event.data.plan,
        } : conversation,
      };
    case "questionnaire.requested":
      return { ...scoped, questionnaire: event.data };
    case "questionnaire.resolved":
      return scoped.questionnaire?.id === event.data.requestId ? { ...scoped, questionnaire: undefined } : scoped;
    case "agent.completed":
      return finishAgent(scoped, "complete");
    case "agent.cancelled":
      return finishAgent(scoped, "cancelled");
    case "agent.error":
      return finishAgent(scoped, "error", event.data.error);
    case "publish.completed":
      return project ? {
        ...scoped,
        project: {
          ...project,
          publication: {
            gameId: event.data.game.id,
            deploymentId: event.data.game.deploymentId,
            playUrl: event.data.game.playUrl,
            publishedAt: event.data.game.publishedAt,
          },
        },
      } : next;
    case "publish.error":
      return { ...scoped, notice: event.data.error };
    case "publish.started":
      return scoped;
    default:
      return scoped;
  }
}

function finishAgent(
  state: RendererState,
  status: "complete" | "cancelled" | "error",
  error?: string,
): RendererState {
  if (!state.conversation) return state;
  return {
    ...state,
    questionnaire: undefined,
    conversation: {
      ...state.conversation,
      agent: status === "error" ? { status: "error", error } : { status: "idle" },
    },
  };
}

function eventTime(event: RuntimeEvent): number | undefined {
  const value = Date.parse(event.timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function upsertItem(items: ThreadItem[], incoming: ThreadItem): ThreadItem[] {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...items, incoming];
  return items.map((item, itemIndex) => itemIndex === index ? incoming : item);
}

function updateItem(items: ThreadItem[], id: string, update: (item: ThreadItem) => ThreadItem): ThreadItem[] {
  return items.map((item) => item.id === id ? update(item) : item);
}
