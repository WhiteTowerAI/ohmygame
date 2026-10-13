import type { ProjectPreviewSettings } from "./preview-settings.js";
import type { PublishCommunityGame, PublishDeployment } from "./publish-v1.js";
import type { WebSearchToolMetadata } from "./web-search.js";

export type PreviewStatus = "waiting" | "stopped" | "starting" | "ready" | "error";
export type AgentStatus = "idle" | "running" | "cancelling" | "error";
export const PROJECT_TYPE_IDS = ["general", "web-game", "interactive-story", "asset-canvas", "godot-game"] as const;
export type ProjectType = (typeof PROJECT_TYPE_IDS)[number];
export const PROJECT_PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type ProjectPackageManager = (typeof PROJECT_PACKAGE_MANAGERS)[number];
export const PREVIEW_VIEWPORTS = ["fit", "tablet", "mobile"] as const;
export type PreviewViewport = (typeof PREVIEW_VIEWPORTS)[number];
export const PROJECT_FILE_OPEN_MODES = ["default", "reveal", "vscode", "zed", "text-editor"] as const;
export type ProjectFileOpenMode = (typeof PROJECT_FILE_OPEN_MODES)[number];

export interface AgentContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export type AgentModelRef = ModelRef;

export interface AgentModel extends AgentModelRef {
  name: string;
  providerName: string;
  reasoningLevels: AgentReasoningLevel[];
}

export interface AgentModelCatalog {
  models: AgentModel[];
  hiddenModels?: AgentModel[];
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

export type ProviderStatus = "connected" | "not_configured" | "connecting" | "error";
export type ProviderCapability = "language" | "image" | "3d" | "video";
export type MediaModelUsage = Exclude<ProviderCapability, "language">;
/** Missing entries inherit the global default for that kind of generation. */
export type MediaModelDefaults = Partial<Record<MediaModelUsage, ModelRef>>;

export interface ProviderSummary extends ModelProviderSummary {
  managed?: "free_cloud";
  cloud?: import("./cloud-models.js").CloudConnectionState;
  status: ProviderStatus;
  capabilities: ProviderCapability[];
  enabled?: boolean;
  custom?: boolean;
  preset?: CustomProviderPreset;
  error?: string;
}

export interface CustomProviderSettings {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  authentication: "api_key" | "none";
  preset?: CustomProviderPreset;
  modelConfigurationVersion?: 2;
}

export type CustomProviderPreset = "gateway" | "ollama" | "lmstudio" | "google" | "openrouter" | "seedance" | "meshy" | "tripo" | "hyper3d";

export interface CustomImageModelSettings {
  protocol: ImageProtocol;
  baseUrl?: string;
  resolutions: ImageResolution[];
  aspectRatios: ImageAspectRatio[];
  maxReferenceImages: number;
  maxOutputs: ImageOutputCount;
}

export type VideoProtocol = "openrouter-videos" | "seedance";
export interface CustomVideoModelSettings {
  protocol: VideoProtocol;
  baseUrl?: string;
  resolutions: VideoResolution[];
  aspectRatios: VideoAspectRatio[];
  durations: number[];
  maxReferenceImages: number;
  referenceModes: Array<"frame" | "reference">;
}

export type Model3DOperation = "image" | "text" | "retexture" | "remesh" | "animate";
export type Model3DActionId = number | string;
export interface Model3DOptions {
  pose?: "a-pose" | "t-pose";
  textureModel?: string;
  textureQuality?: "fast" | "standard" | "detailed" | "extreme";
  rigModel?: "v1.0-20240301" | "v2.5-20260210";
  rigType?: "biped" | "quadruped" | "hexapod" | "octopod" | "serpentine" | "aquatic";
  animateInPlace?: boolean;
}
export interface Model3DMetadata {
  triangles: number;
  textured: boolean;
  rigged: boolean;
  animations: string[];
  forwardAxis?: "+X" | "+Z";
  provider?: string;
  operation?: Model3DOperation;
}
export interface Model3DBalance { balance: number; frozen?: number; }

export interface CustomModel3DSettings {
  protocol: "meshy" | "tripo" | "hyper3d";
  baseUrl?: string;
  operation: "image-to-3d" | "multi-image-to-3d";
  /** Extra operations explicitly enabled for this compatible API connection. */
  operations?: Model3DOperation[];
  modelType: "standard" | "smart-topology";
  maxReferenceImages: number;
  polycount: Model3DModel["polycount"];
  supportsTexture: boolean;
  supportsPbr: boolean;
  defaults?: { texture: boolean; pbr: boolean };
}

export interface Model3DDefinition {
  id: string;
  name: string;
  settings: CustomModel3DSettings;
}

export interface CustomModelUsages {
  language?: boolean;
  image?: CustomImageModelSettings;
  video?: CustomVideoModelSettings;
  "3d"?: CustomModel3DSettings;
}

export interface SaveCustomProviderRequest extends Omit<CustomProviderSettings, "id"> {
  apiKey?: string;
  models?: CustomProviderModel[];
  hiddenModelIds?: string[];
}

export interface CustomProviderDetails extends CustomProviderSettings {
  models: CustomProviderModel[];
  hiddenModelIds: string[];
}

export type DiscoverProviderModelsRequest = Pick<SaveCustomProviderRequest, "baseUrl" | "api" | "authentication" | "apiKey" | "preset"> & { providerId?: string };

export interface DiscoveredProviderModels {
  models: CustomProviderModel[];
  truncated?: boolean;
  warnings?: string[];
  source?: "provider" | "presets";
}

export interface ModelProviderEndpointSettings {
  baseUrl: string;
}

export const CUSTOM_MODEL_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "google-vertex"] as const;
export const CUSTOM_IMAGE_MODEL_APIS = ["openai-completions", "openai-responses"] as const;

export type CustomThinkingLevelMap = Partial<Record<AgentReasoningLevel, string | null>>;
export interface CustomReasoningCapabilities {
  source: "provider" | "catalog";
  thinkingLevelMap: CustomThinkingLevelMap;
  /** Catalog fallback for the editor when endpoint metadata becomes stale; never persisted. */
  catalogThinkingLevelMap?: CustomThinkingLevelMap;
}

export interface CustomProviderModel {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** Only explicit user overrides are written to the SDK model definition. */
  thinkingLevelMap?: CustomThinkingLevelMap;
  reasoningCapabilities?: CustomReasoningCapabilities;
  supportsImages: boolean;
  /** Undefined is a legacy language model; an empty object is explicitly unassigned. */
  usages?: CustomModelUsages;
}

export interface ProviderModelSettings {
  catalogDocsUrl?: string;
  models: Array<AgentModel & { visible: boolean; custom: boolean; capabilities?: ProviderCapability[];
    source?: "preset" | "custom" | "cloud"; model3d?: Model3DDefinition; description?: string }>;
  defaultApi: string;
  defaultBaseUrl?: string;
  canAddCustomModel: boolean;
  model3DProtocol?: CustomModel3DSettings["protocol"];
  catalogNotice?: string;
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

export type ImageModelRef = ModelRef;

/** Why a connected provider offers no media models, so the canvas can say so instead of hiding it. */
export interface MediaProviderStatus {
  cloud?: import("./cloud-models.js").CloudConnectionState;
  provider: string;
  providerName: string;
  state: "ready" | "empty" | "error";
  message?: string;
}

export interface MediaModelCatalog<Model> {
  models: Model[];
  providers: MediaProviderStatus[];
  defaultModel?: ModelRef;
}

export type ImageModelCatalog = MediaModelCatalog<ImageModel>;

export type Model3DModelRef = ModelRef;

export interface Model3DModel extends Model3DModelRef {
  protocol?: CustomModel3DSettings["protocol"];
  operations?: Model3DOperation[];
  referenceImageLabels?: readonly string[];
  name: string;
  providerName: string;
  /** Distinct views of one object; the first is treated as the front. */
  maxReferenceImages: number;
  polycount: { min: number; max: number; default: number; presets: readonly number[] };
  supportsTexture?: boolean;
  supportsPbr?: boolean;
  defaults?: { texture: boolean; pbr: boolean };
  generationLabel?: string;
  estimatedCredits?: number;
}

/** A preset move from the 3D provider's animation library. */
export interface Model3DAnimationAction {
  id: Model3DActionId;
  name: string;
  category: string;
  subCategory: string;
  previewUrl?: string;
}

export interface ImageModel extends ImageModelRef {
  name: string;
  providerName: string;
  sizes: readonly ImageSize[];
  generationOptions: readonly ImageGenerationOption[];
  supportsReferenceImage: boolean;
  maxReferenceImages?: number;
  maxOutputs: ImageOutputCount;
  protocol: ImageProtocol;
  supportsResolution?: boolean;
  supportsAspectRatio?: boolean;
}

export type ImageProtocol = "openai-images" | "gemini-generate-content" | "openrouter-images" | "volcengine-images";

export interface PublicationState {
  gameId: string;
  deploymentId: string;
  playUrl: string;
  publishedAt: string;
  title?: string;
  description?: string;
}

export type ProjectCoverMode = "auto" | "custom";

export interface ProjectCoverState {
  mode: ProjectCoverMode;
}

export interface PreviewRuntimeState {
  status: PreviewStatus;
  url?: string;
  error?: string;
  diagnostic?: import("./preview-diagnostics.js").PreviewDiagnostic;
  diagnostics?: import("./preview-diagnostics.js").PreviewDiagnostic[];
  phase?: "checking" | "installing" | "launching" | "connecting";
  startedAt?: string;
  logs?: string;
  command?: string;
  directory?: string;
  manager?: ProjectPackageManager;
  managerSource?: string;
  revision?: number;
  pages?: { client: string; source: import("./preview-page.js").PreviewPageSource; path: string }[];
  stopReason?: "manual" | "idle" | "settings" | "recovery";
}

export interface ProjectState extends ProjectPreviewSettings {
  id: string;
  name: string;
  type: ProjectType;
  updatedAt: string;
  workspacePath: string;
  /** General Game's explicit Web preview opt-in; missing means disabled. */
  webPreviewEnabled?: boolean;
  /** Directory, relative to the workspace root, in which the Web Game preview starts. */
  startupDirectory?: string;
  /** Package script that starts the Web Game preview. Defaults to `dev`. */
  startupScript?: string;
  /** Overrides automatic package-manager detection for the Web Game preview and build. */
  packageManager?: ProjectPackageManager;
  /** Route shown when a Web Game preview starts. */
  previewPath?: string;
  /** Device preset selected when a Web Game preview starts. */
  previewViewport?: PreviewViewport;
  mediaModelDefaults?: MediaModelDefaults;
  /** Internal OhMyGame data kept separately from a user-selected workspace. */
  storagePath?: string;
  /** Whether OhMyGame owns the workspace directory or only references it. */
  workspaceLocation?: "managed" | "external";
  /** False when a previously selected workspace is no longer available on disk. */
  workspaceAvailable?: boolean;
  preview: PreviewRuntimeState;
  publication?: PublicationState;
}

export interface ProjectRunSettings extends ProjectPreviewSettings {
  startupDirectory: string;
  startupScript: string;
  packageManager?: ProjectPackageManager;
  previewPath: string;
  previewViewport: PreviewViewport;
  webPreviewEnabled?: boolean;
}

export interface ProjectAgentActivity {
  projectId: string;
  status: Extract<AgentStatus, "running" | "cancelling">;
}

export type AssetCanvasNodeType = "text" | "image" | "video" | "model-3d" | "animate-3d" | "asset" | "document" | "table";

export interface AssetCanvasPosition {
  x: number;
  y: number;
}

export interface AssetCanvasNodeLayout extends AssetCanvasPosition {
  width?: number;
  height?: number;
}

export interface AssetCanvasEditorLayout {
  version: 1;
  nodes: Record<string, AssetCanvasNodeLayout>;
  viewport: { x: number; y: number; zoom: number };
  /** Fit a remixed board once its nodes are measured, then save the new viewport. */
  fitView?: boolean;
  view: "canvas";
}

export type AssetCanvasReference =
  | { type: "library"; assetId: string }
  | { type: "node"; nodeId: string };

export interface AssetCanvasTextReference {
  type: "node";
  nodeId: string;
}

export interface AssetCanvasTextGenerationRequest {
  instruction: string;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  referenceSource?: AssetCanvasTextGenerationSource;
}

export interface AssetCanvasTextGenerationSource {
  boardId: string;
  nodeId: string;
}

export interface AssetCanvasTextGenerationResponse {
  text: string;
  model: AgentModelRef;
}

export type AssetCanvasNode = (
  | { id: string; type: "table"; position: AssetCanvasPosition; data: { tableId: string } }
  | { id: string; type: "document"; position: AssetCanvasPosition; data: { documentId: string; references?: AssetCanvasTextReference[] } }
  | { id: string; type: "asset"; position: AssetCanvasPosition; data: {
    assetId: string;
    mediaType: "image" | "video" | "audio" | "model";
  } }
  | { id: string; type: "text"; position: AssetCanvasPosition; data: {
    text: string;
    instruction: string;
    model?: AgentModelRef;
    reasoningLevel?: AgentReasoningLevel;
    references?: AssetCanvasTextReference[];
  } }
  | { id: string; type: "image"; position: AssetCanvasPosition; data: {
    prompt: string;
    promptSource?: AssetCanvasTextReference;
    model?: ImageModelRef;
    resolution: ImageResolution;
    aspectRatio: ImageAspectRatio;
    images: AssetCanvasReference[];
    assetId?: string;
  } }
  | { id: string; type: "video"; position: AssetCanvasPosition; data: {
    prompt: string;
    promptSource?: AssetCanvasTextReference;
    model?: VideoModelRef;
    resolution: VideoResolution;
    aspectRatio: VideoAspectRatio;
    duration: number;
    references: AssetCanvasReference[];
    referenceMode?: VideoReferenceMode;
    referenceMentions?: Record<string, AssetCanvasReference>;
    assetId?: string;
  } }
  | { id: string; type: "model-3d"; position: AssetCanvasPosition; data: {
    operation?: Exclude<Model3DOperation, "animate">;
    prompt?: string;
    promptSource?: AssetCanvasTextReference;
    source?: AssetCanvasReference;
    options?: Model3DOptions;
    model?: Model3DModelRef;
    targetPolycount: number;
    texture: boolean;
    pbr: boolean;
    images: AssetCanvasReference[];
    assetId?: string;
  } }
  | { id: string; type: "animate-3d"; position: AssetCanvasPosition; data: {
    model?: Model3DModelRef;
    options?: Model3DOptions;
    /** The source GLB: a 3D output node, a model Asset node, or a Library model. */
    source?: AssetCanvasReference;
    heightMeters: number;
    /** Library actions in clip order. */
    actionIds: Model3DActionId[];
    assetId?: string;
  } }
) & { title?: string; description?: string; width?: number; height?: number };

export interface AssetCanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface AssetCanvasDocument {
  version: 1;
  /** Hydrated editor state, persisted separately in canvas/editor/<board-id>.json. */
  editorLayout: AssetCanvasEditorLayout;
  viewport: { width: number; height: number };
  nodes: AssetCanvasNode[];
  edges: AssetCanvasEdge[];
}

/** Logical pixel size of a game screen. */
export interface Viewport {
  width: number;
  height: number;
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

export type ThreadItemErrorCode = "model_not_configured" | "authentication_failed" | "access_denied" |
  "quota_exceeded" | "rate_limited" | "invalid_request" | "model_unavailable" | "provider_unavailable" |
  "dns_error" | "connection_refused" | "connection_reset" | "timeout" | "tls_error" |
  "stream_error" | "network_error";

export interface AgentErrorCause {
  name?: string;
  message?: string;
  code?: string;
}

export interface AgentErrorDiagnostics {
  provider?: string;
  model?: string;
  endpoint?: string;
  statusCode?: number;
  requestId?: string;
  errorCode?: string;
  causes?: AgentErrorCause[];
  network?: { source: "environment" | "system" | "manual" | "direct"; proxyUrl?: string };
  retryAttempts?: number;
}

export interface ThreadItemError {
  message: string;
  code?: ThreadItemErrorCode;
  diagnostics?: AgentErrorDiagnostics;
}

export interface PromptReference {
  type: "workspace-file";
  path: string;
}

/**
 * Editor context sent with a prompt, such as the Node open in the Playable
 * editor, an element picked in its preview, a drawing on it, or media added from it. The agent reads `text`; the
 * conversation shows only the label.
 */
export interface PromptContext {
  kind: "playable-node" | "playable-element" | "playable-drawing" | "playable-asset" | "design-document" | "canvas-board";
  label: string;
  text: string;
}

export type PromptContextLabel = Pick<PromptContext, "kind" | "label">;

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
  /** Display-only reference. UI projections leave data empty; model inputs retain it. */
  url?: string;
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
  steering?: boolean;
}

export type CommunityGame = PublishCommunityGame;

export interface PublishResult {
  deployment: PublishDeployment;
  game: Omit<CommunityGame, "author">;
}

export interface PublishProjectRequest {
  accessToken: string;
  title: string;
  description?: string;
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
  | { id: string; turnId: string; type: "userMessage"; text: string; mentions?: PluginMention[]; images?: PromptImage[]; attachments?: ConversationAttachment[]; contexts?: PromptContextLabel[] }
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
      images?: PromptImage[];
      webSearch?: WebSearchToolMetadata;
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
      images?: PromptImage[];
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
  steering?: boolean;
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
  /** Starts the workspace as a copy of a packaged example (see GET /examples). */
  exampleId?: string;
  viewport?: Viewport;
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
  contexts?: PromptContext[];
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
  directory?: true;
  mediaType?: "image" | "video" | "audio" | "model";
  prompt?: string;
  previewPath?: string;
  libraryAssetId?: string;
  origin?: LibraryAssetOrigin;
  purpose?: LibraryAssetPurpose;
}

export type LibraryAssetOrigin = "generated" | "uploaded" | "workspace" | "builtin" | "unknown";
export type LibraryAssetPurpose = "asset" | "reference";

export interface LibraryAsset {
  model3d?: Model3DMetadata;
  id: string;
  name: string;
  size: number;
  mediaType: NonNullable<WorkspaceFile["mediaType"]>;
  contentType: string;
  createdAt: string;
  duration?: number;
  /** Pixel dimensions of image and video content, read from the file header. */
  width?: number;
  height?: number;
  prompt?: string;
  origin?: LibraryAssetOrigin;
  purpose?: LibraryAssetPurpose;
  /** Project copies remain available by ID without appearing in the saved collection. */
  saved?: boolean;
}

export interface LibraryAssetProject {
  id: string;
  name: string;
  type: ProjectType;
}

export interface LibraryAssetSummary extends LibraryAsset {
  projects: LibraryAssetProject[];
  referenceOnly: boolean;
}

export type LibraryUploadMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/svg+xml"
  | "image/webp"
  | "video/mp4"
  | "video/quicktime"
  | "video/webm"
  | "audio/mpeg"
  | "audio/wav";

export interface CreateLibraryImageRequest {
  name: string;
  purpose?: LibraryAssetPurpose;
  image: PromptImage & { mediaType: Extract<LibraryUploadMediaType, `image/${string}`> };
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
export const IMAGE_MAX_REFERENCE_IMAGES = 16;
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

export const VIDEO_ASPECT_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoModelRef = ModelRef;
export type VideoReferenceMode = "frame" | "reference";
export interface VideoModel extends VideoModelRef {
  name: string;
  provider: string;
  providerName: string;
  resolutions: readonly VideoResolution[];
  aspectRatios: readonly VideoAspectRatio[];
  durations: readonly number[];
  maxImageReferences: number;
  imageReferenceMode?: "frame" | "reference";
  referenceModes?: readonly VideoReferenceMode[];
  /** A narrower ratio set used when image references are present. */
  imageAspectRatios?: readonly VideoAspectRatio[];
  frameAspectRatios?: readonly VideoAspectRatio[];
}
export const VIDEO_RESOLUTIONS = ["480p", "720p", "768p", "1080p", "1K", "2K", "4K"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export interface Model3DGenerationConfig {
  model?: Model3DModelRef;
  targetPolycount: number;
  texture: boolean;
  pbr: boolean;
}

export const TOOL_IDS = ["generate-image", "image-to-3d", "generate-video", "animate-3d"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

interface RunSizedImageToolRequest {
  prompt: string;
  imageModel?: ImageModelRef;
  size?: ImageSize;
  resolution?: never;
  aspectRatio?: never;
  outputs?: never;
  image?: never;
}

interface RunConfiguredImageToolRequest {
  prompt: string;
  imageModel?: ImageModelRef;
  size?: never;
  resolution: ImageResolution;
  aspectRatio: ImageAspectRatio;
  outputs?: ImageOutputCount;
  images?: PromptImage[];
}

export type RunImageToolRequest = RunSizedImageToolRequest | RunConfiguredImageToolRequest;

export interface Run3DToolRequest {
  operation?: Exclude<Model3DOperation, "animate">;
  prompt?: string;
  sourceAssetId?: string;
  options?: Model3DOptions;
  images: PromptImage[];
  model?: Model3DModelRef;
  targetPolycount?: number;
  texture?: boolean;
  pbr?: boolean;
}

export interface RunVideoToolRequest {
  prompt: string;
  referenceMode?: VideoReferenceMode;
  model?: VideoModelRef;
  references?: VideoGenerationReference[];
  duration?: number;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
}

export interface VideoGenerationReference {
  type: "image" | "video" | "audio";
  assetId: string;
}

/** Rigs a Library model and bakes the selected provider's preset actions into it. */
export interface RunAnimate3DToolRequest {
  model?: Model3DModelRef;
  options?: Model3DOptions;
  assetId: string;
  actionIds: Model3DActionId[];
  heightMeters?: number;
}

export type RunToolRequest = RunImageToolRequest | Run3DToolRequest | RunVideoToolRequest | RunAnimate3DToolRequest;

export interface ToolRunFile {
  name: string;
  mediaType: string;
  assetId?: string;
}

export interface ToolRun {
  model?: ModelRef;
  id: string;
  toolId: ToolId;
  createdAt: string;
  files: ToolRunFile[];
}

export type ToolJobStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ToolJobContext {
  projectId: string;
  nodeId: string;
  boardId?: string;
}

export interface ToolJob {
  model?: ModelRef;
  id: string;
  toolId: ToolId;
  createdAt: string;
  status: ToolJobStatus;
  title: string;
  context?: ToolJobContext;
  run?: ToolRun;
  error?: string;
}

export type ToolArtifact =
  | { type: "image"; path: string; mediaType: "image/png" | "image/jpeg" | "image/webp" }
  | { type: "model"; path: string; mediaType: "model/gltf-binary" }
  | { type: "video"; path: string; mediaType: "video/mp4" | "video/webm" };

export interface RuntimeEventData {
  "conversation.renamed": { conversation: ConversationSummary };
  "conversation.model.changed": { item: Extract<ThreadItem, { type: "modelChange" }> };
  "project.renamed": { project: ProjectState };
  "project.updated": { project: ProjectState };
  "preview.updated": { preview: PreviewRuntimeState };
  "agent.started": { prompt: string; mentions?: PluginMention[]; images?: PromptImage[]; attachments?: ConversationAttachment[]; contexts?: PromptContextLabel[]; revision?: "last-turn" };
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
  "prompt.steered": { prompt: string; mentions?: PluginMention[]; references: PromptReference[]; images?: PromptImage[]; attachments?: ConversationAttachment[] };
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
  "project.updated",
  "preview.updated",
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
  "prompt.steered",
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
