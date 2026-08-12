export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";

export interface PublicationState {
  gameId: string;
  deploymentId: string;
  playUrl: string;
  publishedAt: string;
}

export interface ProjectState {
  id: string;
  name: string;
  workspacePath: string;
  preview: { status: PreviewStatus; url?: string; error?: string };
  agent: { status: AgentStatus; error?: string };
  publication?: PublicationState;
}

export interface Deployment {
  id: string;
  projectId: string;
  playUrl: string;
  createdAt: string;
}

export interface CommunityGame {
  id: string;
  projectId: string;
  title: string;
  deploymentId: string;
  playUrl: string;
  publishedAt: string;
}

export interface PublishResult {
  deployment: Deployment;
  game: CommunityGame;
}

export type ConversationItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; status: "complete" | "cancelled" | "error"; error?: string }
  | { id: string; kind: "tool"; toolCallId: string; toolName: string; status: "complete" | "error" };

export interface ProjectConversation {
  items: ConversationItem[];
  cursor: number;
}

export interface CreateProjectRequest { name?: string }
export interface PromptRequest { prompt: string }

export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
export type ImageSize = (typeof IMAGE_SIZES)[number];

export interface ToolDefinition {
  id: "generate-image";
  name: string;
  description: string;
  category: "images";
  sizes: readonly ImageSize[];
  defaultSize: ImageSize;
}

export interface RunImageToolRequest {
  prompt: string;
  size?: ImageSize;
}

export interface ToolRunFile {
  name: string;
  mediaType: string;
}

export interface ToolRun {
  id: string;
  toolId: ToolDefinition["id"];
  createdAt: string;
  files: ToolRunFile[];
}

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
  "publish.started": Record<string, never>;
  "publish.completed": { game: CommunityGame };
  "publish.error": { error: string };
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
  "publish.started",
  "publish.completed",
  "publish.error",
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
