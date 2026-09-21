import type { CreatePublishAssetReleaseResult, PublishCommunityGame, PublishDeployment, PublishExploreAsset } from "./publish-v1.js";

export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";
export type ProjectType = "web-game" | "godot-game" | "interactive-drama";

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

export type ProviderKind = "pi" | "account";
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
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string; optional?: boolean }
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
  generationOptions: readonly ImageGenerationOption[];
  supportsReferenceImage: boolean;
  maxOutputs: ImageOutputCount;
  protocol: ImageProtocol;
}

export type ImageProtocol = "openai-images" | "gemini-generate-content";

export interface UpdateImageGenerationSettings {
  model: ImageModelRef;
}

export interface PublicationState {
  gameId: string;
  deploymentId: string;
  playUrl: string;
  publishedAt: string;
  title?: string;
  description?: string;
}

export interface ProjectState {
  id: string;
  name: string;
  type: ProjectType;
  updatedAt: string;
  workspacePath: string;
  /** Internal OhMyGame data kept separately from a user-selected workspace. */
  storagePath?: string;
  /** Whether OhMyGame owns the workspace directory or only references it. */
  workspaceLocation?: "managed" | "external";
  /** False when a previously selected workspace is no longer available on disk. */
  workspaceAvailable?: boolean;
  preview: { status: PreviewStatus; url?: string; error?: string };
  publication?: PublicationState;
}

export type StoryNodeType = "start" | "update-state" | "condition" | "open-ui" | "story-map" | "scene" | "interaction" | "choice" | "ending" | "text" | "image" | "video" | "asset";

export interface StoryPosition {
  x: number;
  y: number;
}

export interface StoryChoiceOption {
  id: string;
  label: string;
  condition?: StoryVariableCondition;
  actions?: StoryAction[];
}

export type StoryVariableType = "boolean" | "number" | "text";
export type StoryVariableValue = boolean | number | string;

export interface StoryVariable {
  id: string;
  name: string;
  type: StoryVariableType;
  initialValue: StoryVariableValue;
}

export interface StoryVariableCondition {
  variableId: string;
  operator: "equals" | "not-equals" | "greater-than" | "greater-than-or-equal" | "less-than" | "less-than-or-equal";
  value: StoryVariableValue;
}

export type StoryVariableOperator = "set" | "add" | "subtract" | "multiply" | "divide";

export interface StoryAction {
  type: "update-variable";
  variableId: string;
  operator: StoryVariableOperator;
  value: StoryVariableValue;
}

export interface StoryChoiceTimeout {
  durationMs: number;
  defaultOptionId: string;
}

export interface StoryInteractionTimeout {
  durationMs: number;
  outcome: string;
}

export type StorySceneMedia =
  | { id: string; type: "image"; source: StoryAssetReference }
  | { id: string; type: "video"; source: StoryAssetReference };

/** Code owned by a Scene. Source paths are authoritative on disk; files are hydrated for the editor/runtime. */
export interface StorySceneSurface {
  source?: StorySourceFiles;
  files: StorySurfaceFiles;
}

export type StorySurfaceLayout = Record<string, StorySurfaceLayoutOffset>;

export interface StorySurfaceLayoutOffset {
  offsetX: number;
  offsetY: number;
}

/** Shared player-facing presentation owned by every visible Story node. */
export interface StoryNodePresentation {
  media: { items: StorySceneMedia[] };
  surface: StorySceneSurface;
}

export interface StoryOpenUiPresentation extends StoryNodePresentation {
  surface: StorySceneSurface & { layout?: StorySurfaceLayout };
}

export interface StorySurfaceFiles {
  html: string;
  css: string;
  javascript: string;
}

/** Stable workspace paths for code authored outside of story.json. */
export interface StorySourceFiles {
  html: string;
  css: string;
  javascript: string;
}

export type StoryInteractionCommand =
  | { type: "set-variable"; variable: string; value: StoryVariableValue }
  | { type: "increment-variable"; variable: string; amount: number };

export interface StoryEditorLayout {
  version: 1;
  nodes: Record<string, StoryPosition>;
  viewport: { x: number; y: number; zoom: number };
  view: "canvas" | "code";
}

export type StoryAssetReference =
  | { type: "library"; assetId: string }
  | { type: "node"; nodeId: string };

export interface StoryTextReference {
  type: "node";
  nodeId: string;
}

export interface StoryTextGenerationRequest {
  instruction: string;
  model?: AgentModelRef;
}

export interface StoryTextGenerationResponse {
  text: string;
  model: AgentModelRef;
}

export type StoryNode = (
  | { id: string; type: "start"; position: StoryPosition; data: Record<string, never> }
  | { id: string; type: "update-state"; position: StoryPosition; data: { title: string; actions: StoryAction[] } }
  | { id: string; type: "condition"; position: StoryPosition; data: { title: string; condition?: StoryVariableCondition } }
  | { id: string; type: "open-ui"; position: StoryPosition; data: {
    title: string;
    content: StoryOpenUiContent;
    presentation: StoryOpenUiPresentation;
  } }
  | { id: string; type: "story-map"; position: StoryPosition; data: {
    title: string;
    presentation: StoryNodePresentation;
  } }
  | { id: string; type: "scene"; position: StoryPosition; data: {
    title: string;
    durationMs?: number;
    presentation: StoryNodePresentation;
  } }
  | { id: string; type: "interaction"; position: StoryPosition; data: { title: string; outcomes: string[]; timeout?: StoryInteractionTimeout; presentation: StoryNodePresentation } }
  | { id: string; type: "choice"; position: StoryPosition; data: { title: string; options: StoryChoiceOption[]; timeout?: StoryChoiceTimeout; presentation: StoryNodePresentation } }
  | { id: string; type: "ending"; position: StoryPosition; data: { title: string; description: string; presentation: StoryNodePresentation } }
  | { id: string; type: "asset"; position: StoryPosition; data: {
    assetId: string;
    mediaType: "image" | "video" | "audio";
  } }
  | { id: string; type: "text"; position: StoryPosition; data: {
    text: string;
    instruction: string;
    model?: AgentModelRef;
  } }
  | { id: string; type: "image"; position: StoryPosition; data: {
    prompt: string;
    promptSource?: StoryTextReference;
    model?: ImageModelRef;
    resolution: ImageResolution;
    aspectRatio: ImageAspectRatio;
    images: StoryAssetReference[];
    assetId?: string;
  } }
  | { id: string; type: "video"; position: StoryPosition; data: {
    prompt: string;
    promptSource?: StoryTextReference;
    model: typeof VIDEO_MODEL;
    resolution: VideoResolution;
    aspectRatio: VideoAspectRatio;
    duration: number;
    references: StoryAssetReference[];
    assetId?: string;
  } }
);

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

export interface StoryPlayerConfig {
  title: string;
  /** Logical pixel dimensions shared by every runtime player surface. */
  viewport: {
    width: number;
    height: number;
  };
  theme: {
    accentColor: string;
    textColor: string;
    font: "sans" | "serif";
  };
  videoFit: "contain" | "cover";
  choicePosition: "center" | "bottom";
}

export type StoryOpenUiAction = "start-game" | "continue-game" | "new-game" | "open-story-map";
export type StoryScreenAction = StoryOpenUiAction | "close";

export interface StoryOpenUiButton {
  id: string;
  label: string;
  action: StoryOpenUiAction;
}

export interface StoryOpenUiContent {
  title: string;
  buttons: StoryOpenUiButton[];
}

export interface StoryDocument {
  version: 1;
  /** Hydrated editor-only state. Persisted in editor/layout.json, not story.json. */
  editorLayout: StoryEditorLayout;
  player: StoryPlayerConfig;
  variables: StoryVariable[];
  chapter: StoryChapter;
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

export type ThreadItemErrorCode = "model_not_configured";

export interface ThreadItemError {
  message: string;
  code?: ThreadItemErrorCode;
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
  name?: string;
}

export type PromptAttachmentKind = "image" | "text" | "document" | "audio" | "video" | "model" | "archive" | "binary";

/** A locally stored file made available to the agent for the current prompt. */
export interface PromptAttachment {
  id: string;
  batchId: string;
  name: string;
  relativePath: string;
  size: number;
  kind: PromptAttachmentKind;
  mediaType?: string;
}

/** Metadata displayed with a user message; it never exposes the local attachment ID. */
export type ConversationAttachment = Omit<PromptAttachment, "id" | "batchId">;

export interface PendingPrompt {
  turnId: string;
  prompt: string;
  mentions: PluginMention[];
  references: PromptReference[];
  images: PromptImage[];
  attachments: ConversationAttachment[];
}

export type CommunityGame = PublishCommunityGame;

export interface PublishResult {
  deployment: PublishDeployment;
  game: Omit<CommunityGame, "author" | "stats">;
}

export interface PublishProjectRequest {
  accessToken: string;
  title: string;
  description?: string;
}

export type ExploreAsset = PublishExploreAsset;

export interface PublishAssetRequest {
  accessToken: string;
}

export type PublishAssetResult = CreatePublishAssetReleaseResult;

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
  | { id: string; turnId: string; type: "userMessage"; text: string; mentions?: PluginMention[]; images?: PromptImage[]; attachments?: ConversationAttachment[] }
  | { id: string; turnId: string; type: "imageRead"; count: number; status: "completed" }
  | { id: string; turnId: string; type: "modelChange"; model: AgentModelRef; name?: string }
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
      status: Extract<ItemStatus, "inProgress" | "completed" | "cancelled" | "failed">;
      summary?: string;
      tokensBefore?: number;
      estimatedTokensAfter?: number;
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

export interface CreateProjectRequest {
  name?: string;
  type?: ProjectType;
  templateId?: "night-train";
  storyViewport?: StoryPlayerConfig["viewport"];
  /** Absolute path returned by the desktop directory picker. */
  workspacePath?: string;
}
export interface CreateConversationRequest {
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
}
export interface UpdateAgentDefaultsRequest {
  model: AgentModelRef;
  reasoningLevel: AgentReasoningLevel;
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
  attachments?: Array<Pick<PromptAttachment, "id" | "batchId">>;
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
    marketplaceDisplayName: string;
  }>;
  skills: Array<{
    name: string;
    description: string;
    pluginDisplayName?: string;
    marketplaceDisplayName?: string;
  }>;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  mediaType?: "image" | "video" | "audio" | "model";
  prompt?: string;
  previewPath?: string;
  publication?: AssetPublicationState;
  libraryAssetId?: string;
}

export interface LibraryAsset {
  id: string;
  name: string;
  size: number;
  mediaType: NonNullable<WorkspaceFile["mediaType"]>;
  contentType: string;
  createdAt: string;
  duration?: number;
  prompt?: string;
  publication?: AssetPublicationState;
}

export type LibraryUploadMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm"
  | "audio/mpeg"
  | "audio/wav";

export interface CreateLibraryImageRequest {
  name: string;
  image: PromptImage & { mediaType: Extract<LibraryUploadMediaType, `image/${string}`> };
}

export interface AssetPublicationState {
  assetId: string;
  releaseId: string;
  publishedAt: string;
  status: "listed" | "unlisted";
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
export const IMAGE_RESOLUTIONS = ["512", "1K", "2K", "4K"] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export const IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];
export const IMAGE_OUTPUT_COUNTS = [1, 2, 3, 4] as const;
export type ImageOutputCount = (typeof IMAGE_OUTPUT_COUNTS)[number];

export interface ImageGenerationOption {
  resolution: ImageResolution;
  aspectRatio: ImageAspectRatio;
}

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

export interface Model3DToolDefinition extends BaseToolDefinition {
  id: "image-to-3d";
  category: "3d";
  inputKind: "image-prompt";
  outputKind: "model";
}

export interface VideoToolDefinition extends BaseToolDefinition {
  id: "generate-video";
  category: "video";
  inputKind: "image-prompt";
  outputKind: "video";
  defaultDuration: number;
  minDuration: number;
  maxDuration: number;
  aspectRatios: readonly VideoAspectRatio[];
  resolutions: readonly VideoResolution[];
}

export const VIDEO_ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export const VIDEO_MODEL = "doubao-seedance-2-0-260128" as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const MODEL_3D_QUALITIES = ["standard", "ultra"] as const;
export type Model3DQuality = (typeof MODEL_3D_QUALITIES)[number];
export const MODEL_3D_MODELS = ["meshy-7", "meshy-t2"] as const;
export type Model3DModel = (typeof MODEL_3D_MODELS)[number];
export const MODEL_3D_TEXTURE_RESOLUTIONS = ["2K", "4K", "8K"] as const;
export type Model3DTextureResolution = (typeof MODEL_3D_TEXTURE_RESOLUTIONS)[number];
export const MODEL_3D_POSES = ["auto", "a-pose", "t-pose"] as const;
export type Model3DPose = (typeof MODEL_3D_POSES)[number];

export type ToolDefinition = ImageToolDefinition | Model3DToolDefinition | VideoToolDefinition;

interface RunLegacyImageToolRequest {
  prompt: string;
  imageModel?: ImageModelRef;
  size?: ImageSize;
  resolution?: never;
  aspectRatio?: never;
  outputs?: never;
  image?: never;
}

interface RunStudioImageToolRequest {
  prompt: string;
  imageModel?: ImageModelRef;
  size?: never;
  resolution: ImageResolution;
  aspectRatio: ImageAspectRatio;
  outputs?: ImageOutputCount;
  images?: PromptImage[];
}

export type RunImageToolRequest = RunLegacyImageToolRequest | RunStudioImageToolRequest;

interface Run3DToolOptions {
  model?: Model3DModel;
  quality?: Model3DQuality;
  targetPolycount?: number;
  texture?: boolean;
  textureResolution?: Model3DTextureResolution;
  pbr?: boolean;
  pose?: Model3DPose;
}

export type Run3DToolRequest = Run3DToolOptions & (
  | { prompt: string; images?: never; imageEnhancement?: never }
  | { prompt?: never; images: PromptImage[]; imageEnhancement?: boolean }
);

export interface RunVideoToolRequest {
  prompt: string;
  references?: VideoGenerationReference[];
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
}

export interface VideoGenerationReference {
  type: "image" | "video" | "audio";
  assetId: string;
}

export type RunToolRequest = RunImageToolRequest | Run3DToolRequest | RunVideoToolRequest;

export interface ToolRunFile {
  name: string;
  mediaType: string;
  assetId?: string;
  publication?: AssetPublicationState;
}

export interface ToolRun {
  id: string;
  toolId: ToolDefinition["id"];
  createdAt: string;
  files: ToolRunFile[];
  title?: string;
}

export type ToolJobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ToolJob {
  id: string;
  toolId: ToolDefinition["id"];
  createdAt: string;
  status: ToolJobStatus;
  title: string;
  run?: ToolRun;
  error?: string;
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
  "conversation.renamed": { conversation: ConversationSummary };
  "conversation.model.changed": { item: Extract<ThreadItem, { type: "modelChange" }> };
  "project.renamed": { project: ProjectState };
  "preview.starting": Record<string, never>;
  "preview.ready": { url: string };
  "preview.error": { error: string };
  "preview.stopped": Record<string, never>;
  "agent.started": { prompt: string; mentions?: PluginMention[]; images?: PromptImage[]; attachments?: ConversationAttachment[]; revision?: "last-turn" };
  "plan.mode.changed": PlanSessionState;
  "item.started": { item: ThreadItem };
  "item.updated": { item: ThreadItem };
  "item.completed": { item: ThreadItem };
  "item.agentMessage.delta": { itemId: string; delta: string };
  "item.reasoning.textDelta": { itemId: string; delta: string };
  "agent.completed": Record<string, never>;
  "agent.cancelled": Record<string, never>;
  "agent.error": { error: string };
  "prompt.queued": { prompt: string; mentions?: PluginMention[]; references: PromptReference[]; images?: PromptImage[]; attachments?: ConversationAttachment[] };
  "prompt.removed": Record<string, never>;
  "publish.started": Record<string, never>;
  "publish.completed": { game: PublishResult["game"] };
  "publish.error": { error: string };
}

export type RuntimeEventType = keyof RuntimeEventData;

export const RUNTIME_EVENT_TYPES = [
  "conversation.renamed",
  "conversation.model.changed",
  "project.renamed",
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
