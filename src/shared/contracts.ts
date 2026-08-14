import type { PublishCommunityGame, PublishDeployment } from "./publish-v1.js";

export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";

export interface AgentModelRef {
  provider: string;
  id: string;
}

export interface AgentModel extends AgentModelRef {
  name: string;
}

export interface AgentModelCatalog {
  models: AgentModel[];
  defaultModel?: AgentModelRef;
}

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
  publication?: PublicationState;
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationState extends ConversationSummary {
  agent: { status: AgentStatus; turnId?: string; error?: string };
  model?: AgentModelRef;
}

export interface ActiveTurnState {
  conversationId: string;
  turnId: string;
}

export interface PromptReference {
  type: "workspace-file";
  path: string;
}

export interface PendingPrompt {
  turnId: string;
  prompt: string;
  references: PromptReference[];
}

export type CommunityGame = PublishCommunityGame;

export interface PublishResult {
  deployment: PublishDeployment;
  game: CommunityGame;
}

export type AgentItem = (
  | { id: string; turnId: string; kind: "user"; text: string }
  | {
      id: string;
      turnId: string;
      kind: "assistant";
      text: string;
      status: "streaming" | "complete" | "cancelled" | "interrupted" | "error";
      error?: string;
    }
  | {
      id: string;
      turnId: string;
      kind: "tool";
      toolCallId: string;
      toolName: string;
      status: "running" | "complete" | "error";
      args?: unknown;
      output?: string;
      truncated?: boolean;
    }
  | {
      id: string;
      turnId: string;
      kind: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | {
      id: string;
      turnId: string;
      kind: "compaction";
      status: "running" | "complete" | "error";
      error?: string;
    }
) & { timestamp?: number };

export interface ConversationDetail {
  conversation: ConversationState;
  items: AgentItem[];
  cursor: number;
  activeTurn?: ActiveTurnState;
  pendingPrompt?: PendingPrompt;
}

export interface CreateProjectRequest { name?: string }
export interface CreateConversationRequest { model?: AgentModelRef }
export interface RenameConversationRequest { title: string }
export type SetConversationModelRequest = AgentModelRef;
export interface PromptRequest {
  prompt: string;
  references?: PromptReference[];
}

export interface PromptResponse {
  turnId: string;
  queued: boolean;
}

export interface RemovePendingPromptRequest {
  turnId: string;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  mediaType?: "image" | "video" | "audio";
}

export interface WorkspaceFileContent {
  path: string;
  size: number;
  binary: boolean;
  content?: string;
  truncated?: boolean;
}

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

export interface ToolSettings {
  enabledTools: ToolDefinition["id"][];
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

export interface AddToolResultRequest {
  runId: string;
  fileName: string;
}

export interface AddedProjectAsset {
  path: string;
}

export interface RuntimeEventData {
  "preview.starting": Record<string, never>;
  "preview.ready": { url: string };
  "preview.error": { error: string };
  "preview.stopped": Record<string, never>;
  "agent.started": { prompt: string };
  "agent.retrying": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "agent.compaction.started": { reason: "manual" | "threshold" | "overflow" };
  "agent.compaction.completed": { aborted: boolean; willRetry: boolean; error?: string };
  "assistant.started": { itemId: string };
  "assistant.thinking": Record<string, never>;
  "assistant.delta": { itemId: string; delta: string };
  "assistant.completed": { itemId: string; status: "complete" | "cancelled" | "error"; error?: string };
  "tool.started": { itemId: string; toolCallId: string; toolName: string; args?: unknown };
  "tool.updated": { itemId: string; toolCallId: string; output?: string; truncated?: boolean };
  "tool.completed": { itemId: string; toolCallId: string; toolName: string; isError: boolean; output?: string; truncated?: boolean };
  "agent.completed": Record<string, never>;
  "agent.cancelled": Record<string, never>;
  "agent.error": { error: string };
  "prompt.queued": { prompt: string; references: PromptReference[] };
  "prompt.removed": Record<string, never>;
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
  "agent.compaction.started",
  "agent.compaction.completed",
  "assistant.started",
  "assistant.thinking",
  "assistant.delta",
  "assistant.completed",
  "tool.started",
  "tool.updated",
  "tool.completed",
  "agent.completed",
  "agent.cancelled",
  "agent.error",
  "prompt.queued",
  "prompt.removed",
  "publish.started",
  "publish.completed",
  "publish.error",
] as const satisfies readonly RuntimeEventType[];

export type RuntimeEvent<T extends RuntimeEventType = RuntimeEventType> = T extends RuntimeEventType
  ? {
      id: number;
      projectId: string;
      conversationId?: string;
      turnId?: string;
      type: T;
      timestamp: string;
      data: RuntimeEventData[T];
    }
  : never;
