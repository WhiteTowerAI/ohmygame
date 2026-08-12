import type { ProjectState, RuntimeEvent } from "../shared/contracts.js";

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export type TimelineItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; status: "streaming" | "complete" | "cancelled" | "error"; error?: string; retry?: string }
  | { id: string; kind: "tool"; toolCallId: string; toolName: string; status: "running" | "complete" | "error" };

export interface RendererState {
  phase: "loading" | "ready" | "fatal";
  connection: ConnectionStatus;
  project?: ProjectState;
  items: TimelineItem[];
  activeAssistantId?: string;
  retry?: { attempt: number; maxAttempts: number };
  lastEventId: number;
  notice?: string;
}

export type RendererAction =
  | { type: "initialized"; project: ProjectState }
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
  if (action.type === "initialized") {
    return { ...state, phase: "ready", project: action.project };
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

  switch (event.type) {
    case "preview.starting":
      return project ? { ...next, project: { ...project, preview: { status: "starting" } } } : next;
    case "preview.ready":
      return project ? { ...next, project: { ...project, preview: { status: "ready", url: event.data.url } } } : next;
    case "preview.error":
      return project ? { ...next, project: { ...project, preview: { status: "error", error: event.data.error } } } : next;
    case "preview.stopped":
      return project ? { ...next, project: { ...project, preview: { status: "stopped" } } } : next;
    case "agent.started": {
      const assistantId = `${event.id}:assistant`;
      return {
        ...next,
        project: project ? { ...project, agent: { status: "running" } } : project,
        activeAssistantId: assistantId,
        retry: undefined,
        items: [
          ...state.items,
          { id: `${event.id}:user`, kind: "user", text: event.data.prompt },
          { id: assistantId, kind: "assistant", text: "", status: "streaming" },
        ],
      };
    }
    case "agent.retrying": {
      const retry = { attempt: event.data.attempt, maxAttempts: event.data.maxAttempts };
      const message = `Retrying ${retry.attempt}/${retry.maxAttempts}: ${event.data.error}`;
      return {
        ...updateAssistant(next, (item) => ({ ...item, retry: message })),
        retry,
      };
    }
    case "assistant.delta":
      return updateAssistant({ ...next, retry: undefined }, (item) => ({ ...item, text: item.text + event.data.delta }));
    case "tool.started":
      return {
        ...next,
        retry: undefined,
        items: [
          ...state.items,
          {
            id: `${event.id}:tool`,
            kind: "tool",
            toolCallId: event.data.toolCallId,
            toolName: event.data.toolName,
            status: "running",
          },
        ],
      };
    case "tool.completed":
      return {
        ...next,
        items: state.items.map((item) => item.kind === "tool" && item.toolCallId === event.data.toolCallId
          ? { ...item, status: event.data.isError ? "error" : "complete" }
          : item),
      };
    case "agent.completed":
      return finishAgent(next, "complete");
    case "agent.cancelled":
      return finishAgent(next, "cancelled");
    case "agent.error":
      return finishAgent(next, "error", event.data.error);
    default:
      return next;
  }
}

function updateAssistant(
  state: RendererState,
  update: (item: Extract<TimelineItem, { kind: "assistant" }>) => TimelineItem,
): RendererState {
  if (!state.activeAssistantId) return state;
  return {
    ...state,
    items: state.items.map((item) => item.kind === "assistant" && item.id === state.activeAssistantId ? update(item) : item),
  };
}

function finishAgent(
  state: RendererState,
  status: "complete" | "cancelled" | "error",
  error?: string,
): RendererState {
  const updated = updateAssistant(state, (item) => ({ ...item, status, error }));
  if (!state.project) return { ...updated, activeAssistantId: undefined };
  return {
    ...updated,
    activeAssistantId: undefined,
    retry: undefined,
    project: {
      ...state.project,
      agent: status === "error" ? { status: "error", error } : { status: "idle" },
    },
  };
}
