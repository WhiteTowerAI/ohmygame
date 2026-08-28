import type { PublishCommunityGame, PublishDeployment } from "./publish-v1.js";

export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";
export type ProjectType = "general" | "interactive-drama";

export interface AgentContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface AgentModelRef {
  provider: string;
  id: string;
}

export interface AgentModel extends AgentModelRef {
  name: string;
  providerName: string;
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

export type ProviderKind = "pi" | "portal" | "custom";
export type ProviderStatus = "connected" | "not_configured" | "connecting" | "error";
export type ProviderCapability = "language" | "image" | "3d" | "video";

export interface ProviderSummary extends ModelProviderSummary {
  kind: ProviderKind;
  status: ProviderStatus;
  capabilities: ProviderCapability[];
  error?: string;
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
  model?: ImageModelRef;
}

export interface ImageModelRef {
  provider: string;
  id: string;
}

export interface ImageModel extends ImageModelRef {
  name: string;
  providerName: string;
  sizes: readonly ImageSize[];
  protocol: ImageProtocol;
}

export type ImageProtocol = "openai-images" | "gemini-generate-content";

export interface UpdateImageGenerationSettings {
  model: ImageModelRef;
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
  type: ProjectType;
  updatedAt: string;
  workspacePath: string;
  preview: { status: PreviewStatus; url?: string; error?: string };
  publication?: PublicationState;
}

export type StoryNodeType = "start" | "scene" | "choice" | "ending";

export interface StoryPosition {
  x: number;
  y: number;
}

export interface StoryChoiceOption {
  id: string;
  label: string;
}

export type StoryNode =
  | { id: string; type: "start"; position: StoryPosition; data: Record<string, never> }
  | { id: string; type: "scene"; position: StoryPosition; data: { title: string; description: string } }
  | { id: string; type: "choice"; position: StoryPosition; data: { title: string; options: StoryChoiceOption[] } }
  | { id: string; type: "ending"; position: StoryPosition; data: { title: string; description: string } };

export interface StoryEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface StoryChapter {
  id: string;
  title: string;
  nodes: StoryNode[];
  edges: StoryEdge[];
}

export interface StoryDocument {
  version: 1;
  chapters: StoryChapter[];
}

export interface ConversationSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationAgentState {
  status: AgentStatus;
  error?: string;
}

export type ItemStatus = "preparing" | "inProgress" | "completed" | "cancelled" | "interrupted" | "failed";
export type TurnStatus = Extract<ItemStatus, "inProgress" | "completed" | "cancelled" | "interrupted" | "failed">;

export interface ThreadItemError {
  message: string;
  code?: string;
}

export interface PromptReference {
  type: "workspace-file";
  path: string;
}

export interface PluginMention {
  name: string;
  displayName: string;
  marketplaceId: string;
}

export type PromptImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface PromptImage {
  mediaType: PromptImageMediaType;
  data: string;
}

export interface PendingPrompt {
  turnId: string;
  prompt: string;
  mentions: PluginMention[];
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

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface PlanState {
  explanation?: string;
  steps: PlanStep[];
}

export type ThreadItem = (
  | { id: string; turnId: string; type: "userMessage"; text: string; mentions?: PluginMention[]; images?: PromptImage[] }
  | {
      id: string;
      turnId: string;
      type: "agentMessage";
      text: string;
      status: Extract<ItemStatus, "inProgress" | "completed" | "cancelled" | "interrupted" | "failed">;
      phase?: AgentMessagePhase;
      error?: ThreadItemError;
    }
  | {
      id: string;
      turnId: string;
      type: "reasoning";
      text: string;
      status: Extract<ItemStatus, "inProgress" | "completed">;
    }
  | {
      id: string;
      turnId: string;
      type: "plan";
      plan: PlanState;
    }
  | {
      id: string;
      turnId: string;
      type: "dynamicToolCall";
      toolCallId: string;
      tool: string;
      status: Extract<ItemStatus, "preparing" | "inProgress" | "completed" | "failed">;
      arguments?: unknown;
      output?: string;
      truncated?: boolean;
      artifact?: ToolArtifact;
    }
  | {
      id: string;
      turnId: string;
      type: "mcpToolCall";
      toolCallId: string;
      server?: string;
      tool: string;
      status: Extract<ItemStatus, "preparing" | "inProgress" | "completed" | "failed">;
      arguments?: unknown;
      output?: string;
      truncated?: boolean;
      artifact?: ToolArtifact;
    }
  | {
      id: string;
      turnId: string;
      type: "retry";
      status: Extract<ItemStatus, "inProgress" | "completed" | "failed">;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: ThreadItemError;
    }
  | {
      id: string;
      turnId: string;
      type: "contextCompaction";
      status: Extract<ItemStatus, "inProgress" | "completed" | "failed">;
      error?: ThreadItemError;
    }
  | {
      id: string;
      turnId: string;
      type: "userInputRequest";
      requestId: string;
      questions: QuestionnaireQuestion[];
      status: Extract<ItemStatus, "inProgress" | "completed" | "cancelled" | "failed">;
      answers?: QuestionnaireAnswer[];
      error?: ThreadItemError;
    }
) & { timestamp?: number };

export interface Turn {
  id: string;
  conversationId: string;
  status: TurnStatus;
  items: ThreadItem[];
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  agent: ConversationAgentState;
  settings: ConversationAgentSettings;
  plan: PlanSessionState;
  turns: Turn[];
  cursor: number;
  pendingPrompts: PendingPrompt[];
}

export type PlanMode = "normal" | "planning" | "awaiting_approval" | "executing";
export type PromptMode = Extract<PlanMode, "normal" | "planning">;

export interface PlanSessionState {
  mode: PlanMode;
  plan?: PlanState;
}

export interface QuestionnaireOption {
  value: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionnaireQuestion {
  id: string;
  prompt: string;
  options: QuestionnaireOption[];
  allowOther: boolean;
}

export interface QuestionnaireAnswer {
  questionId: string;
  value: string;
  label: string;
  custom: boolean;
}

export interface QuestionnaireResult {
  answers: QuestionnaireAnswer[];
  cancelled: boolean;
}

export interface AnswerQuestionnaireRequest {
  requestId: string;
  answers?: Array<{ questionId: string; value: string }>;
  cancelled?: boolean;
}

export interface CreateProjectRequest { name?: string; type?: ProjectType }
export interface CreateConversationRequest {
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
export interface RenameConversationRequest { title: string }
export type SetConversationModelRequest = AgentModelRef;
export interface SetConversationReasoningRequest { level: AgentReasoningLevel }
export interface ConversationAgentSettings {
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
export interface PromptRequest {
  prompt: string;
  mentions?: PluginMention[];
  references?: PromptReference[];
  images?: PromptImage[];
  mode?: PromptMode;
}

export interface ReviseLastPromptRequest { prompt: string }

export interface PromptResponse {
  turnId: string;
  queued: boolean;
}

export interface ConversationCapabilities {
  plugins: Array<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    marketplaceId: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
  }>;
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
  id: "generate-image" | "image-to-3d" | "generate-video";
  name: string;
  description: string;
  category: "images" | "3d" | "video";
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

export interface VideoToolDefinition extends BaseToolDefinition {
  id: "generate-video";
  category: "video";
  inputKind: "image-prompt";
  outputKind: "video";
  defaultDuration: number;
  aspectRatios: readonly VideoAspectRatio[];
  resolutions: readonly VideoResolution[];
  durations: readonly number[];
}

export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export const VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];
export const VIDEO_DURATIONS = [6, 10] as const;

export type ToolDefinition = ImageToolDefinition | ImageTo3DToolDefinition | VideoToolDefinition;

export interface RunImageToolRequest {
  prompt: string;
  size?: ImageSize;
}

export interface RunImageTo3DToolRequest {
  image: PromptImage;
}

export interface RunVideoToolRequest {
  prompt: string;
  image?: PromptImage;
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
}

export type RunToolRequest = RunImageToolRequest | RunImageTo3DToolRequest | RunVideoToolRequest;

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

export type ToolArtifact =
  | { type: "image"; path: string; mediaType: "image/png" | "image/jpeg" | "image/webp" }
  | { type: "model"; path: string; mediaType: "model/gltf-binary" }
  | { type: "video"; path: string; mediaType: "video/mp4" | "video/webm" };

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
  "agent.started": { prompt: string; mentions?: PluginMention[]; images?: PromptImage[]; revision?: "last-turn" };
  "plan.mode.changed": PlanSessionState;
  "item.started": { item: ThreadItem };
  "item.updated": { item: ThreadItem };
  "item.completed": { item: ThreadItem };
  "item.agentMessage.delta": { itemId: string; delta: string };
  "item.reasoning.textDelta": { itemId: string; delta: string };
  "agent.completed": Record<string, never>;
  "agent.cancelled": Record<string, never>;
  "agent.error": { error: string };
  "prompt.queued": { prompt: string; mentions?: PluginMention[]; references: PromptReference[]; images?: PromptImage[] };
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
  "item.started",
  "item.updated",
  "item.completed",
  "item.agentMessage.delta",
  "item.reasoning.textDelta",
  "plan.mode.changed",
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
