import type { ActiveTurnState, AgentItem, ApprovalRequest, ConversationState, PendingPrompt, ProjectState, RuntimeEvent } from "../shared/contracts.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export type TimelineItem = AgentItem;

export interface RendererState {
  phase: "loading" | "ready" | "fatal";
  connection: ConnectionStatus;
  project?: ProjectState;
  conversation?: ConversationState;
  activeTurn?: ActiveTurnState;
  pendingPrompt?: PendingPrompt;
  pendingApproval?: ApprovalRequest;
  items: TimelineItem[];
  retry?: { attempt: number; maxAttempts: number };
  lastEventId: number;
  notice?: string;
}

export type RendererAction =
  | { type: "initialized"; project: ProjectState; conversation: ConversationState; items?: AgentItem[]; activeTurn?: ActiveTurnState; pendingPrompt?: PendingPrompt; pendingApproval?: ApprovalRequest; cursor: number }
  | { type: "conversation-loaded"; conversation: ConversationState; items: AgentItem[]; activeTurn?: ActiveTurnState; pendingPrompt?: PendingPrompt; pendingApproval?: ApprovalRequest; cursor: number }
  | { type: "runtime-event"; event: RuntimeEvent }
  | { type: "connection"; status: ConnectionStatus }
  | { type: "notice"; message?: string }
  | { type: "fatal"; message: string };

export const initialRendererState: RendererState = {
  phase: "loading",
  connection: "connecting",
  items: [],
  lastEventId: 0,
};

export function rendererReducer(state: RendererState, action: RendererAction): RendererState {
  if (action.type === "conversation-loaded") {
    return {
      ...state,
      phase: "ready",
      conversation: action.conversation,
      activeTurn: action.activeTurn,
      pendingPrompt: action.pendingPrompt,
      pendingApproval: action.pendingApproval,
      items: action.items,
      retry: undefined,
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
      pendingPrompt: action.pendingPrompt,
      pendingApproval: action.pendingApproval,
      items: action.items ?? state.items,
      lastEventId: action.cursor,
    };
  }
  if (action.type === "connection") return { ...state, connection: action.status };
  if (action.type === "notice") return { ...state, notice: action.message };
  if (action.type === "fatal") return { ...state, phase: "fatal", notice: action.message };
  if (action.event.id <= state.lastEventId) return state;
  return reduceRuntimeEvent(state, action.event);
}

export function reduceRuntimeEvent(state: RendererState, event: RuntimeEvent): RendererState {
  const next = { ...state, lastEventId: event.id, notice: undefined };
  const project = state.project;
  const conversation = state.conversation;
  const agentEvent = event.type.startsWith("agent.") || event.type.startsWith("assistant.") || event.type.startsWith("tool.") || event.type.startsWith("prompt.") || event.type.startsWith("approval.");
  let scoped = next;

  if (event.type === "agent.started" && event.conversationId && event.turnId) {
    scoped = { ...scoped, activeTurn: { conversationId: event.conversationId, turnId: event.turnId } };
  } else if (
    (event.type === "agent.completed" || event.type === "agent.cancelled" || event.type === "agent.error") &&
    state.activeTurn?.turnId === event.turnId
  ) {
    scoped = { ...scoped, activeTurn: undefined };
  }

  if (agentEvent && (!conversation || event.conversationId !== conversation.id)) return scoped;

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
      return {
        ...scoped,
        conversation: conversation ? { ...conversation, agent: { status: "running", turnId: event.turnId } } : conversation,
        pendingPrompt: state.pendingPrompt?.turnId === event.turnId ? undefined : state.pendingPrompt,
        retry: undefined,
        items: [
          ...state.items,
          { id: `${event.turnId}:user`, turnId: event.turnId, kind: "user", text: event.data.prompt },
        ],
      };
    }
    case "prompt.queued":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        pendingPrompt: { turnId: event.turnId, prompt: event.data.prompt, references: event.data.references },
      };
    case "prompt.removed":
      return { ...scoped, pendingPrompt: undefined };
    case "agent.retrying": {
      if (!event.turnId) return scoped;
      const retry = { attempt: event.data.attempt, maxAttempts: event.data.maxAttempts };
      return {
        ...scoped,
        retry,
        items: upsertItem(state.items, {
          id: `${event.turnId}:retry:${event.data.attempt}`,
          turnId: event.turnId,
          kind: "retry",
          ...event.data,
        }),
      };
    }
    case "agent.compaction.started":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        items: upsertItem(state.items, {
          id: `${event.turnId}:compaction`,
          turnId: event.turnId,
          kind: "compaction",
          status: "running",
        }),
      };
    case "agent.compaction.completed":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        items: updateItem(state.items, `${event.turnId}:compaction`, (item) => item.kind === "compaction" ? {
          ...item,
          status: event.data.aborted ? "error" : "complete",
          error: event.data.error ?? (event.data.aborted
            ? event.data.willRetry ? "Context compaction interrupted; retrying" : "Context compaction interrupted"
            : undefined),
        } : item),
      };
    case "approval.requested":
      return { ...scoped, pendingApproval: event.data.approval };
    case "approval.resolved":
      return state.pendingApproval?.id === event.data.approvalId ? { ...scoped, pendingApproval: undefined } : scoped;
    case "assistant.started":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        items: upsertItem(state.items, {
          id: event.data.itemId,
          turnId: event.turnId,
          kind: "assistant",
          text: "",
          status: "streaming",
        }),
      };
    case "assistant.delta":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        retry: undefined,
        items: updateItem(state.items, event.data.itemId, (item) => item.kind === "assistant"
          ? { ...item, text: item.text + event.data.delta }
          : item),
      };
    case "assistant.completed":
      return {
        ...scoped,
        items: state.items.flatMap((item) => {
          if (item.id !== event.data.itemId || item.kind !== "assistant") return [item];
          if (!item.text && event.data.status === "complete") return [];
          return [{ ...item, status: event.data.status, error: event.data.error }];
        }),
      };
    case "tool.started":
      if (!event.turnId) return scoped;
      return {
        ...scoped,
        retry: undefined,
        items: upsertItem(state.items, {
          id: event.data.itemId,
          turnId: event.turnId,
          kind: "tool",
          toolCallId: event.data.toolCallId,
          toolName: event.data.toolName,
          status: "running",
          args: event.data.args,
        }),
      };
    case "tool.updated":
      return {
        ...scoped,
        items: updateItem(state.items, event.data.itemId, (item) => item.kind === "tool"
          ? { ...item, output: event.data.output ?? item.output, truncated: event.data.truncated ?? item.truncated }
          : item),
      };
    case "tool.completed":
      return {
        ...scoped,
        items: updateItem(state.items, event.data.itemId, (item) => item.kind === "tool" ? {
          ...item,
          status: event.data.isError ? "error" : "complete",
          output: event.data.output ?? item.output,
          truncated: event.data.truncated ?? item.truncated,
        } : item),
      };
    case "agent.completed":
      return finishAgent(scoped, event.turnId, "complete");
    case "agent.cancelled":
      return finishAgent(scoped, event.turnId, "cancelled");
    case "agent.error":
      return finishAgent(scoped, event.turnId, "error", event.data.error);
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
  turnId: string | undefined,
  status: "complete" | "cancelled" | "error",
  error?: string,
): RendererState {
  const finalizedItems = !turnId ? state.items : state.items.flatMap((item) => {
    if (item.turnId !== turnId || item.kind !== "assistant" || item.status !== "streaming") return [item];
    if (status === "complete" && !item.text) return [];
    return [{ ...item, status, error }];
  });
  const hasFailure = status !== "complete" && turnId && finalizedItems.some((item) => (
    item.turnId === turnId && item.kind === "assistant" && item.status === status
  ));
  const items = status === "complete" || !turnId || hasFailure ? finalizedItems : [
    ...finalizedItems,
    {
      id: `${turnId}:status`,
      turnId,
      kind: "assistant" as const,
      text: "",
      status,
      error,
    },
  ];
  if (!state.conversation) return { ...state, items, retry: undefined };
  return {
    ...state,
    items,
    retry: undefined,
    pendingApproval: undefined,
    conversation: {
      ...state.conversation,
      agent: status === "error" ? { status: "error", error } : { status: "idle" },
    },
  };
}

function upsertItem(items: AgentItem[], incoming: AgentItem): AgentItem[] {
  const index = items.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...items, incoming];
  return items.map((item, itemIndex) => itemIndex === index ? incoming : item);
}

function updateItem(items: AgentItem[], id: string, update: (item: AgentItem) => AgentItem): AgentItem[] {
  return items.map((item) => item.id === id ? update(item) : item);
}
