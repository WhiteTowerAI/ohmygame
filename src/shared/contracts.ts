import type { PublishCommunityGame, PublishDeployment } from "./publish-v1.js";

export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";

export interface AgentModelRef {
  provider: string;
  id: string;
}

export interface AgentModel extends AgentModelRef {
  name: string;
  reasoningLevels: AgentReasoningLevel[];
}

export interface AgentModelCatalog {
  models: AgentModel[];
  defaultModel?: AgentModelRef;
  defaultReasoningLevel: AgentReasoningLevel;
}

export const AGENT_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentReasoningLevel = (typeof AGENT_REASONING_LEVELS)[number];

export type ModelAuthMethod = "api_key" | "oauth";

export interface ModelProviderSummary {
  id: string;
  name: string;
  configured: boolean;
  source?: string;
  credentialType?: ModelAuthMethod;
  methods: Array<{ type: ModelAuthMethod; label: string }>;
}

export interface ModelProviderEndpointSettings {
  baseUrl: string;
}

export type ModelAuthPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> };

export type ModelAuthNotification =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export type ModelAuthEvent = {
  id: number;
  operationId: string;
} & (
  | { type: "notification"; notification: ModelAuthNotification }
  | { type: "prompt"; promptId: string; prompt: ModelAuthPrompt }
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "error"; error: string }
);

export interface ImageGenerationSettings {
  apiUrl: string;
  hasApiKey: boolean;
}

export interface UpdateImageGenerationSettings {
  apiUrl: string;
  apiKey?: string;
}

export interface Model3DGenerationSettings {
  apiUrl: string;
  hasApiKey: boolean;
}

export interface UpdateModel3DGenerationSettings {
  apiUrl: string;
  apiKey?: string;
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
  updatedAt: string;
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
  reasoningLevel?: AgentReasoningLevel;
}

export interface ActiveTurnState {
  conversationId: string;
  turnId: string;
}

export interface PromptReference {
  type: "workspace-file";
  path: string;
}

export type PromptImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface PromptImage {
  mediaType: PromptImageMediaType;
  data: string;
}

export interface PendingPrompt {
  turnId: string;
  prompt: string;
  references: PromptReference[];
  images: PromptImage[];
}

export type CommunityGame = PublishCommunityGame;

export interface PublishResult {
  deployment: PublishDeployment;
  game: CommunityGame;
}

export interface PublishProjectRequest {
  accessToken: string;
}

export type AgentMessagePhase = "commentary" | "final_answer";

export type AgentItem = (
  | { id: string; turnId: string; kind: "user"; text: string; images?: PromptImage[] }
  | {
      id: string;
      turnId: string;
      kind: "assistant";
      text: string;
      status: "streaming" | "complete" | "cancelled" | "interrupted" | "error";
      phase?: AgentMessagePhase;
      error?: string;
    }
  | {
      id: string;
      turnId: string;
      kind: "thinking";
      text: string;
      status: "streaming" | "complete";
    }
  | {
      id: string;
      turnId: string;
      kind: "tool";
      toolCallId: string;
      toolName: string;
      status: "preparing" | "running" | "complete" | "error";
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
  pendingPrompts: PendingPrompt[];
}

export interface CreateProjectRequest { name?: string }
export interface CreateConversationRequest {
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
export interface RenameConversationRequest { title: string }
export type SetConversationModelRequest = AgentModelRef;
export interface SetConversationReasoningRequest { level: AgentReasoningLevel }
export interface ConversationAgentSettings {
  model: AgentModelRef;
  reasoningLevel: AgentReasoningLevel;
}
export interface PromptRequest {
  prompt: string;
  references?: PromptReference[];
  images?: PromptImage[];
}

export interface PromptResponse {
  turnId: string;
  queued: boolean;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  mediaType?: "image" | "video" | "audio" | "model";
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

interface BaseToolDefinition {
  id: "generate-image" | "image-to-3d";
  name: string;
  description: string;
  category: "images" | "3d";
}

export interface ImageToolDefinition extends BaseToolDefinition {
  id: "generate-image";
  category: "images";
  inputKind: "prompt";
  outputKind: "image";
  sizes: readonly ImageSize[];
  defaultSize: ImageSize;
}

export interface ImageTo3DToolDefinition extends BaseToolDefinition {
  id: "image-to-3d";
  category: "3d";
  inputKind: "image";
  outputKind: "model";
}

export type ToolDefinition = ImageToolDefinition | ImageTo3DToolDefinition;

export interface ToolSettings {
  enabledTools: ToolDefinition["id"][];
}

export interface RunImageToolRequest {
  prompt: string;
  size?: ImageSize;
}

export interface RunImageTo3DToolRequest {
  image: PromptImage;
}

export type RunToolRequest = RunImageToolRequest | RunImageTo3DToolRequest;

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
  "agent.started": { prompt: string; images?: PromptImage[] };
  "agent.retrying": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "agent.compaction.started": { reason: "manual" | "threshold" | "overflow" };
  "agent.compaction.completed": { aborted: boolean; willRetry: boolean; error?: string };
  "assistant.started": { itemId: string };
  "assistant.thinking.started": { itemId: string };
  "assistant.thinking.delta": { itemId: string; delta: string };
  "assistant.thinking.completed": { itemId: string; text: string };
  "assistant.delta": { itemId: string; delta: string };
  "assistant.completed": { itemId: string; status: "complete" | "cancelled" | "error"; phase?: AgentMessagePhase; error?: string };
  "tool.preparing": { itemId: string; toolCallId: string; toolName: string; args?: unknown };
  "tool.started": { itemId: string; toolCallId: string; toolName: string; args?: unknown };
  "tool.updated": { itemId: string; toolCallId: string; output?: string; truncated?: boolean };
  "tool.completed": { itemId: string; toolCallId: string; toolName: string; isError: boolean; output?: string; truncated?: boolean };
  "agent.completed": Record<string, never>;
  "agent.cancelled": Record<string, never>;
  "agent.error": { error: string };
  "prompt.queued": { prompt: string; references: PromptReference[]; images?: PromptImage[] };
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
  "assistant.thinking.started",
  "assistant.thinking.delta",
  "assistant.thinking.completed",
  "assistant.delta",
  "assistant.completed",
  "tool.preparing",
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
