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
  planMode: PlanMode;
  plan?: PlanState;
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

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface PlanState {
  explanation?: string;
  steps: PlanStep[];
}

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
      kind: "plan";
      plan: PlanState;
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
      artifact?: ToolArtifact;
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
  questionnaire?: QuestionnaireRequest;
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

export interface QuestionnaireRequest {
  id: string;
  questions: QuestionnaireQuestion[];
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
  model: AgentModelRef;
  reasoningLevel: AgentReasoningLevel;
}
export interface PromptRequest {
  prompt: string;
  references?: PromptReference[];
  images?: PromptImage[];
  mode?: PromptMode;
}

export interface ReviseLastPromptRequest { prompt: string }

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

export interface ToolSettings {
  installedTools: ToolDefinition["id"][];
  enabledTools: ToolDefinition["id"][];
}

export type PiPackageResourceType = "extension" | "skill" | "prompt" | "theme";
export type PiPackageCompatibility = "compatible" | "not-verified" | "not-applicable";

export interface PiPackageSummary {
  name: string;
  sourceType: "npm" | "git" | "local" | "url";
  description?: string;
  resourceTypes: PiPackageResourceType[];
  compatibility: PiPackageCompatibility;
  installed: boolean;
  installSpec: string;
}

export interface PiPackageCatalog {
  packages: PiPackageSummary[];
  hasMore: boolean;
}

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
  "agent.started": { prompt: string; images?: PromptImage[]; revision?: "last-turn" };
  "plan.mode.changed": PlanSessionState;
  "agent.retrying": { attempt: number; maxAttempts: number; delayMs: number; error: string };
  "agent.compaction.started": { reason: "manual" | "threshold" | "overflow" };
  "agent.compaction.completed": { reason: "manual" | "threshold" | "overflow"; aborted: boolean; willRetry: boolean; error?: string };
  "assistant.started": { itemId: string };
  "assistant.thinking.started": { itemId: string };
  "assistant.thinking.delta": { itemId: string; delta: string };
  "assistant.thinking.completed": { itemId: string; text: string };
  "assistant.delta": { itemId: string; delta: string };
  "assistant.completed": { itemId: string; status: "complete" | "cancelled" | "error"; phase?: AgentMessagePhase; error?: string };
  "plan.updated": PlanState & { itemId: string };
  "questionnaire.requested": QuestionnaireRequest;
  "questionnaire.resolved": { requestId: string };
  "tool.preparing": { itemId: string; toolCallId: string; toolName: string; args?: unknown };
  "tool.started": { itemId: string; toolCallId: string; toolName: string; args?: unknown };
  "tool.updated": { itemId: string; toolCallId: string; output?: string; truncated?: boolean; artifact?: ToolArtifact };
  "tool.completed": { itemId: string; toolCallId: string; toolName: string; isError: boolean; output?: string; truncated?: boolean; artifact?: ToolArtifact };
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
  "plan.mode.changed",
  "plan.updated",
  "questionnaire.requested",
  "questionnaire.resolved",
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
