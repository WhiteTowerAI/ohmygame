export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";

export interface ProjectState {
  id: string;
  name: string;
  workspacePath: string;
  preview: { status: PreviewStatus; url?: string; error?: string };
  agent: { status: AgentStatus; error?: string };
}

export interface CreateProjectRequest { name?: string }
export interface PromptRequest { prompt: string }

export interface RuntimeEventData {
  "preview.starting": Record<string, never>;
  "preview.ready": { url: string };
  "preview.error": { error: string };
  "preview.stopped": Record<string, never>;
  "agent.started": { prompt: string };
  "agent.retrying": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "assistant.delta": { delta: string };
  "tool.started": { toolCallId: string; toolName: string };
  "tool.completed": { toolCallId: string; toolName: string; isError: boolean };
  "agent.completed": Record<string, never>;
  "agent.cancelled": Record<string, never>;
  "agent.error": { error: string };
}

export type RuntimeEventType = keyof RuntimeEventData;

export const RUNTIME_EVENT_TYPES = [
  "preview.starting",
  "preview.ready",
  "preview.error",
  "preview.stopped",
  "agent.started",
  "agent.retrying",
  "assistant.delta",
  "tool.started",
  "tool.completed",
  "agent.completed",
  "agent.cancelled",
  "agent.error",
] as const satisfies readonly RuntimeEventType[];

export type RuntimeEvent<T extends RuntimeEventType = RuntimeEventType> = T extends RuntimeEventType
  ? {
      id: number;
      projectId: string;
      type: T;
      timestamp: string;
      data: RuntimeEventData[T];
    }
  : never;
