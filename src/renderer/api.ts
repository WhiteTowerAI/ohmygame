import {
  RUNTIME_EVENT_TYPES,
  type AgentContextUsage,
  type AnswerQuestionnaireRequest,
  type AgentModelCatalog,
  type AgentModelRef,
  type AgentReasoningLevel,
  type ConversationAgentSettings,
  type ConversationCapabilities,
  type CreateLibraryImageRequest,
  type LibraryAsset,
  type LibraryUploadMediaType,
  type ImageModel,
  type ModelAuthEvent,
  type ModelAuthMethod,
  type ModelProviderEndpointSettings,
  type ProviderSummary,
  type CreateProjectRequest,
  type CommunityGame,
  type ConversationDetail,
  type ConversationSummary,
  type PreviewViewport,
  type ProjectPackageManager,
  type ProjectFileOpenMode,
  type ProjectState,
  type AssetCanvasDocument,
  type AssetCanvasTextGenerationRequest,
  type AssetCanvasTextGenerationResponse,
  type UpdateAgentDefaultsRequest,
  type PublishProjectRequest,
  type PublishResult,
  type RuntimeEvent,
  type RunToolRequest,
  type ToolId,
  type ToolJob,
  type ToolJobContext,
  type VideoModel,
  type PromptImage,
  type PromptAttachment,
  type PluginMention,
  type PromptMode,
  type PromptContext,
  type PromptReference,
  type PromptResponse,
  type WorkspaceFile,
  type WorkspaceFileContent,
  MediaModelCatalog,
} from "../shared/contracts.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import type { ExampleSummary } from "../shared/examples.js";
import type { PlaytestWatchState } from "../shared/playtest.js";
import type { NodeRuntimeResponse } from "../shared/playable-player-protocol.js";
import type { NodeCodebase, NodeCodebaseUpdate } from "../shared/playable-codebase.js";
import type { PlayableAddedNode, PlayablePresetSummary, PlayableProjectValidationResult as PlayableProjectValidation, PlayableThumbnailManifest } from "../shared/playable-editor.js";
import type { InstallPluginRequest, PluginCatalog, PluginDetail, PluginInstallInspection, PluginSettings, PluginSkillContent } from "../shared/plugins.js";
import type { Connection, SaveConnectionRequest } from "../shared/connections.js";
import type { UpdateWebSearchSettings, WebSearchSettings } from "../shared/web-search.js";

const API_BASE = "/api";

interface DesktopRuntime {
  daemonUrl: string;
  token: string;
}

declare global {
  interface Window {
    ohMyGameDesktop?: {
      platform: string;
      runtime: DesktopRuntime;
      openExternal: (url: string) => Promise<void>;
      setAppearance: (appearance: "system" | "light" | "dark") => Promise<void>;
      openProjectFile: (projectId: string, filePath: string, mode?: ProjectFileOpenMode) => Promise<void>;
      browsePluginDirectory: (pluginId: string) => Promise<void>;
      revealPluginSkill: (pluginId: string, skillId: string) => Promise<void>;
      selectPluginDirectory: () => Promise<string | undefined>;
      selectProjectDirectory: () => Promise<string | undefined>;
      capturePage: (bounds: { x: number; y: number; width: number; height: number }) => Promise<Uint8Array>;
      /** Captures a Node's thumbnail in a hidden window; `false` when it could not. */
      captureNodeThumbnail?: (projectId: string, nodeId: string, viewport: { width: number; height: number }) => Promise<boolean>;
      /** Called by the hidden thumbnail window once its capture is stored or failed. */
      finishNodeThumbnail?: (captured: boolean) => Promise<void>;
      openPlaytest: (projectId: string, viewport: { width: number; height: number }) => Promise<void>;
      /** Called from a Playtest window: shows the Node in the main window's editor. */
      openPlayableNode?: (projectId: string, nodeId: string) => Promise<void>;
      /** Called in the main window when a Playtest asks to open a Node. */
      onOpenPlayableNode?: (listener: (projectId: string, nodeId: string) => void) => () => void;
      agentPlaytests?: {
        state: () => Promise<PlaytestWatchState>;
        setVisible: (visible: boolean) => Promise<PlaytestWatchState>;
        onState: (listener: (state: PlaytestWatchState) => void) => () => void;
      };
      updates: {
        state: () => Promise<DesktopUpdateState | null>;
        check: () => Promise<void>;
        download: () => Promise<void>;
        install: () => Promise<void>;
        onState: (listener: (state: DesktopUpdateState) => void) => () => void;
      };
      auth: {
        callbackUrl: () => Promise<string>;
        cancel: () => Promise<void>;
        openUrl: (url: string) => Promise<void>;
        takeCallback: () => Promise<string | undefined>;
        onCallback: (listener: () => void) => () => void;
      };
    };
  }
}

export async function createProject(input: CreateProjectRequest = {}): Promise<ProjectState> {
  return request("/projects", { method: "POST", body: JSON.stringify(input) });
}

export async function listProjects(): Promise<ProjectState[]> {
  return request("/projects");
}

export async function listExamples(): Promise<ExampleSummary[]> {
  return request("/examples");
}

export async function getExampleCover(exampleId: string): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(`/examples/${encodeURIComponent(exampleId)}/cover`), { headers: runtimeHeaders() });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function renameProject(projectId: string, name: string): Promise<ProjectState> {
  return request(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function updateProjectStartupDirectory(projectId: string, startupDirectory: string): Promise<ProjectState> {
  return request(`/projects/${projectId}/settings/startup-directory`, {
    method: "PUT",
    body: JSON.stringify({ startupDirectory }),
  });
}

export async function updateProjectRunSettings(projectId: string, input: {
  startupDirectory: string;
  startupScript: string;
  packageManager?: ProjectPackageManager;
  previewPath: string;
  previewViewport: PreviewViewport;
}): Promise<ProjectState> {
  return request(`/projects/${projectId}/settings/run`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function duplicateProject(projectId: string): Promise<ProjectState> {
  return request(`/projects/${projectId}/duplicate`, { method: "POST" });
}

export async function deleteProject(projectId: string): Promise<void> {
  await request(`/projects/${projectId}`, { method: "DELETE" });
}

export async function listModels(): Promise<AgentModelCatalog> {
  return request("/models");
}

export async function updateAgentDefaults(input: UpdateAgentDefaultsRequest): Promise<void> {
  await request("/models/default", {
    method: "PUT",
    body: JSON.stringify({ model: modelRef(input.model), reasoningLevel: input.reasoningLevel }),
  });
}

export const MODELS_CHANGED_EVENT = "ohmygame-models-changed";

export function notifyAgentModelsChanged(): void {
  window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
}

export async function listProviders(): Promise<ProviderSummary[]> {
  return request("/settings/providers");
}

export async function getOpenAIEndpointSettings(): Promise<ModelProviderEndpointSettings> {
  return request("/settings/models/providers/openai/endpoint");
}

export async function updateOpenAIEndpointSettings(baseUrl: string): Promise<ModelProviderEndpointSettings> {
  return request("/settings/models/providers/openai/endpoint", {
    method: "PUT",
    body: JSON.stringify({ baseUrl }),
  });
}

export async function updateMeshyApiKey(apiKey: string): Promise<{ configured: boolean }> {
  return request("/settings/models/providers/meshy", { method: "PUT", body: JSON.stringify({ apiKey }) });
}
export async function clearMeshyApiKey(): Promise<void> {
  await request("/settings/models/providers/meshy", { method: "DELETE" });
}

export async function startModelProviderLogin(providerId: string, method: ModelAuthMethod): Promise<string> {
  const result = await request<{ operationId: string }>(`/settings/models/providers/${encodeURIComponent(providerId)}/login`, {
    method: "POST",
    body: JSON.stringify({ method }),
  });
  return result.operationId;
}

export async function respondToModelAuth(operationId: string, promptId: string, value: string): Promise<void> {
  await request(`/settings/model-auth/${encodeURIComponent(operationId)}/respond`, {
    method: "POST",
    body: JSON.stringify({ promptId, value }),
  });
}

export async function cancelModelAuth(operationId: string): Promise<void> {
  await request(`/settings/model-auth/${encodeURIComponent(operationId)}`, { method: "DELETE" });
}

export async function disconnectModelProvider(providerId: string): Promise<void> {
  await request(`/settings/models/providers/${encodeURIComponent(providerId)}/credential`, { method: "DELETE" });
}

export function subscribeToModelAuth(
  operationId: string,
  handlers: { onEvent: (event: ModelAuthEvent) => void; onError: () => void },
): () => void {
  const controller = new AbortController();
  void streamModelAuthEvents(operationId, controller.signal, handlers);
  return () => controller.abort();
}

export async function listImageModels(): Promise<ImageModel[]> {
  return request("/image-models");
}

export async function listVideoModels(): Promise<VideoModel[]> {
  return request("/video-models");
}

/** Image models grouped by connected provider, with the reason a provider has none. */
export async function listImageModelCatalog(): Promise<MediaModelCatalog<ImageModel>> {
  return request("/image-models/catalog");
}

export async function listVideoModelCatalog(): Promise<MediaModelCatalog<VideoModel>> {
  return request("/video-models/catalog");
}

export async function getWebSearchSettings(): Promise<WebSearchSettings> {
  return request("/settings/web-search");
}

export async function updateWebSearchSettings(input: UpdateWebSearchSettings): Promise<WebSearchSettings> {
  return request("/settings/web-search", { method: "PUT", body: JSON.stringify(input) });
}

export async function listExploreGames(): Promise<CommunityGame[]> {
  return request("/community/games");
}

export async function getExploreGame(gameId: string): Promise<CommunityGame> {
  return request(`/community/games/${encodeURIComponent(gameId)}`);
}

export async function getExploreGameCover(gameId: string, deploymentId: string): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(
    `/community/games/${encodeURIComponent(gameId)}/deployments/${encodeURIComponent(deploymentId)}/cover`,
  ), { headers: runtimeHeaders() });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function listPlugins(): Promise<PluginCatalog> {
  return request("/plugins");
}

export async function getHomeComposerCapabilities(): Promise<ConversationCapabilities> {
  return request("/composer/capabilities");
}

export async function createPluginAuthoringSession(): Promise<{ projectId: string; conversationId: string }> {
  return request("/plugins/authoring-session", { method: "POST" });
}

export async function installPlugin(input: InstallPluginRequest): Promise<PluginDetail> {
  return request("/plugins/install", { method: "POST", body: JSON.stringify(input) });
}

export async function inspectPluginSource(input: InstallPluginRequest): Promise<PluginInstallInspection> {
  return request("/plugins/inspect", { method: "POST", body: JSON.stringify(input) });
}

export async function readPlugin(id: string): Promise<PluginDetail> {
  return request(`/plugins/${encodeURIComponent(id)}`);
}

export async function readPluginSkill(pluginId: string, skillId: string): Promise<PluginSkillContent> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/skill-content?id=${encodeURIComponent(skillId)}`);
}

export async function updatePluginSettings(id: string, settings: PluginSettings): Promise<PluginDetail> {
  return request(`/plugins/${encodeURIComponent(id)}/settings`, { method: "PUT", body: JSON.stringify(settings) });
}

export async function uninstallPlugin(id: string): Promise<void> {
  await request(`/plugins/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listConnections(): Promise<Connection[]> {
  return request("/settings/connections");
}

export async function createConnection(input: SaveConnectionRequest): Promise<Connection> {
  return request("/settings/connections", { method: "POST", body: JSON.stringify(input) });
}

export async function updateConnection(id: string, input: SaveConnectionRequest): Promise<Connection> {
  return request(`/settings/connections/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function setConnectionEnabled(id: string, enabled: boolean): Promise<void> {
  await request(`/settings/connections/${encodeURIComponent(id)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled }) });
}

export async function removeConnection(id: string): Promise<void> {
  await request(`/settings/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function startToolJob(toolId: ToolId, input: RunToolRequest, title?: string, context?: ToolJobContext): Promise<ToolJob> {
  return request(`/tools/${toolId}/jobs`, { method: "POST", body: JSON.stringify({ ...input, ...(title ? { title } : {}), ...(context ? { projectId: context.projectId, nodeId: context.nodeId } : {}) }) });
}

export async function listToolJobs(): Promise<ToolJob[]> {
  return request("/tool-jobs");
}

export async function cancelToolJob(jobId: string): Promise<ToolJob> {
  return request(`/tool-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
}

export async function retryToolJob(jobId: string): Promise<ToolJob> {
  return request(`/tool-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST" });
}

export async function publishProject(projectId: string, accessToken: string, metadata: Omit<PublishProjectRequest, "accessToken">): Promise<PublishResult> {
  const body: PublishProjectRequest = { accessToken, ...metadata };
  return request(`/projects/${projectId}/publish`, { method: "POST", body: JSON.stringify(body) });
}

export async function buildInteractiveDrama(projectId: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/projects/${projectId}/interactive-drama/build`), {
    method: "POST",
    headers: runtimeHeaders(),
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function waitForRuntime(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request<{ status: "ok" }>("/health");
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error("Could not reach the local runtime");
}

export async function getProject(projectId: string): Promise<ProjectState> {
  return request(`/projects/${projectId}`);
}

export async function getNodeRuntime(projectId: string): Promise<NodeRuntimeResponse> {
  return request(`/projects/${projectId}/playable`);
}

export async function getNodeCodebase(projectId: string): Promise<NodeCodebase> {
  return request(`/projects/${projectId}/playable/codebase`);
}

export async function getPlayableValidation(
  projectId: string,
  mode: "draft" | "publish" = "draft",
): Promise<PlayableProjectValidation> {
  return request(`/projects/${projectId}/playable/validation?mode=${mode}`);
}

export async function listPlayablePresets(): Promise<{ presets: PlayablePresetSummary[] }> {
  return request("/playable/presets");
}

export async function addPlayableNode(
  projectId: string,
  body: { preset: string; id: string; title?: string; position?: { x: number; y: number } },
): Promise<PlayableAddedNode> {
  return request(`/projects/${projectId}/playable/nodes`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listPlayableThumbnails(projectId: string): Promise<PlayableThumbnailManifest> {
  const { thumbnails } = await request<{ thumbnails: PlayableThumbnailManifest }>(`/projects/${projectId}/playable/thumbnails`);
  return thumbnails;
}

export async function getPlayableThumbnail(projectId: string, nodeId: string): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(`/projects/${projectId}/playable/thumbnails/${encodeURIComponent(nodeId)}`), { headers: runtimeHeaders() });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function setPlayableThumbnail(projectId: string, nodeId: string, hash: string, image: Blob): Promise<void> {
  const response = await fetch(apiUrl(`/projects/${projectId}/playable/thumbnails/${encodeURIComponent(nodeId)}?hash=${encodeURIComponent(hash)}`), {
    method: "PUT",
    headers: { "content-type": "image/webp", ...runtimeHeaders() },
    body: image,
  });
  if (!response.ok) throw await responseError(response);
}

export async function updateNodeCodebase(
  projectId: string,
  codebase: NodeCodebaseUpdate,
): Promise<void> {
  await request(`/projects/${projectId}/playable/codebase`, {
    method: "PUT",
    body: JSON.stringify(codebase),
  });
}

export async function getAssetCanvas(projectId: string): Promise<AssetCanvasDocument> {
  return request(`/projects/${projectId}/asset-canvas`);
}

export async function updateAssetCanvas(projectId: string, document: AssetCanvasDocument): Promise<void> {
  await request(`/projects/${projectId}/asset-canvas`, { method: "PUT", body: JSON.stringify(document) });
}

export async function generateAssetCanvasText(projectId: string, input: AssetCanvasTextGenerationRequest): Promise<AssetCanvasTextGenerationResponse> {
  return request(`/projects/${projectId}/asset-canvas/text/generate`, { method: "POST", body: JSON.stringify(input) });
}

export async function getProjectCover(projectId: string): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(`/projects/${projectId}/cover`), { headers: runtimeHeaders() });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function setProjectCover(projectId: string, cover: Blob): Promise<void> {
  const response = await fetch(apiUrl(`/projects/${projectId}/cover`), {
    method: "PUT",
    headers: { "content-type": "image/webp", ...runtimeHeaders() },
    body: cover,
  });
  if (!response.ok) throw await responseError(response);
}

export async function listWorkspaceFiles(projectId: string): Promise<WorkspaceFile[]> {
  return request(`/projects/${projectId}/files`);
}

export async function renameAsset(projectId: string, filePath: string, name: string): Promise<{ path: string }> {
  return request(`/projects/${projectId}/assets?path=${encodeURIComponent(filePath)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteAsset(projectId: string, filePath: string): Promise<void> {
  await request(`/projects/${projectId}/assets?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
}

export async function listLibraryAssets(): Promise<LibraryAsset[]> {
  return request("/library/assets");
}

export async function createLibraryImage(input: CreateLibraryImageRequest): Promise<LibraryAsset> {
  return request("/library/assets", { method: "POST", body: JSON.stringify(input) });
}

export async function uploadLibraryAsset(file: File, mediaType: LibraryUploadMediaType, duration?: number): Promise<LibraryAsset> {
  const query = new URLSearchParams({ name: file.name, mediaType });
  if (duration !== undefined) query.set("duration", String(duration));
  return request(`/library/assets/upload?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

export async function getLibraryAsset(assetId: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/library/assets/${encodeURIComponent(assetId)}/content`), { headers: runtimeHeaders() });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function renameLibraryAsset(assetId: string, name: string): Promise<LibraryAsset> {
  return request(`/library/assets/${encodeURIComponent(assetId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function deleteLibraryAsset(assetId: string): Promise<void> {
  await request(`/library/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
}

export interface LibraryAssetReference {
  id: string;
  name: string;
  type: ProjectState["type"];
}

export async function listLibraryAssetReferences(assetId: string): Promise<LibraryAssetReference[]> {
  return request(`/library/assets/${encodeURIComponent(assetId)}/references`);
}

export async function forceDeleteLibraryAsset(assetId: string): Promise<void> {
  await request(`/library/assets/${encodeURIComponent(assetId)}?force=true`, { method: "DELETE" });
}

export async function getWorkspaceFile(projectId: string, filePath: string): Promise<WorkspaceFileContent> {
  return request(`/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`);
}

export async function getWorkspaceAsset(projectId: string, filePath: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/projects/${projectId}/files/raw?path=${encodeURIComponent(filePath)}`), {
    headers: runtimeHeaders(),
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function listConversations(projectId: string): Promise<ConversationSummary[]> {
  return request(`/projects/${projectId}/conversations`);
}

export async function createConversation(
  projectId: string,
  model?: AgentModelRef,
  reasoningLevel?: AgentReasoningLevel,
): Promise<ConversationSummary> {
  return request(`/projects/${projectId}/conversations`, {
    method: "POST",
    body: JSON.stringify({ ...(model ? { model: modelRef(model) } : {}), ...(reasoningLevel ? { reasoningLevel } : {}) }),
  });
}

export async function getConversation(projectId: string, conversationId: string, reset = false): Promise<ConversationDetail> {
  return request(`/projects/${projectId}/conversations/${conversationId}${reset ? "?reset=1" : ""}`);
}

export async function renameConversation(
  projectId: string,
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  return request(`/projects/${projectId}/conversations/${conversationId}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

export async function setConversationModel(
  projectId: string,
  conversationId: string,
  model: AgentModelRef,
): Promise<ConversationAgentSettings> {
  return request(`/projects/${projectId}/conversations/${conversationId}/model`, {
    method: "PUT",
    body: JSON.stringify(modelRef(model)),
  });
}

export async function setConversationReasoning(
  projectId: string,
  conversationId: string,
  level: AgentReasoningLevel,
): Promise<AgentReasoningLevel> {
  const result = await request<{ level: AgentReasoningLevel }>(`/projects/${projectId}/conversations/${conversationId}/reasoning`, {
    method: "PUT",
    body: JSON.stringify({ level }),
  });
  return result.level;
}

export async function startPreview(projectId: string): Promise<{ url: string }> {
  return request(`/projects/${projectId}/preview`, { method: "POST" });
}

export async function sendPrompt(
  projectId: string,
  conversationId: string,
  prompt: string,
  references: PromptReference[] = [],
  images: PromptImage[] = [],
  mode: PromptMode = "normal",
  mentions: PluginMention[] = [],
  attachments: PromptAttachment[] = [],
  contexts: PromptContext[] = [],
): Promise<PromptResponse> {
  return request(`/projects/${projectId}/conversations/${conversationId}/turns`, {
    method: "POST",
    body: JSON.stringify({ prompt, ...(mode === "planning" ? { mode } : {}), ...(mentions.length ? { mentions } : {}), ...(references.length ? { references } : {}), ...(images.length ? { images } : {}), ...(attachments.length ? { attachments: attachments.map(({ id, batchId }) => ({ id, batchId })) } : {}), ...(contexts.length ? { contexts } : {}) }),
  });
}

export async function uploadProjectAttachment(
  projectId: string,
  batchId: string,
  file: File,
  relativePath?: string,
): Promise<PromptAttachment> {
  const query = new URLSearchParams({ batchId, name: file.name });
  if (relativePath) query.set("relativePath", relativePath);
  const response = await fetch(apiUrl(`/projects/${encodeURIComponent(projectId)}/attachments?${query}`), {
    method: "POST",
    headers: { "content-type": "application/vnd.ohmygame.attachment", ...runtimeHeaders() },
    body: file,
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<PromptAttachment>;
}

export async function compactConversation(projectId: string, conversationId: string, instructions?: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/compact`, {
    method: "POST",
    body: JSON.stringify(instructions?.trim() ? { instructions: instructions.trim() } : {}),
  });
}

export async function getConversationContextUsage(projectId: string, conversationId: string): Promise<AgentContextUsage | undefined> {
  const result = await request<{ contextUsage?: AgentContextUsage }>(`/projects/${projectId}/conversations/${conversationId}/context-usage`);
  return result.contextUsage;
}

export async function getConversationCapabilities(projectId: string, conversationId: string): Promise<ConversationCapabilities> {
  return request(`/projects/${projectId}/conversations/${conversationId}/capabilities`);
}

export async function approvePlan(projectId: string, conversationId: string): Promise<PromptResponse> {
  return request(`/projects/${projectId}/conversations/${conversationId}/plan/approve`, { method: "POST" });
}

export async function cancelPlan(projectId: string, conversationId: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/plan`, { method: "DELETE" });
}

export async function refinePlan(projectId: string, conversationId: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/plan/refine`, { method: "POST" });
}

export async function answerQuestionnaire(
  projectId: string,
  conversationId: string,
  response: AnswerQuestionnaireRequest,
): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/questionnaire`, {
    method: "POST",
    body: JSON.stringify(response),
  });
}

export async function reviseLastPrompt(
  projectId: string,
  conversationId: string,
  prompt: string,
): Promise<PromptResponse> {
  return request(`/projects/${projectId}/conversations/${conversationId}/revise-last`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
}

export async function removePendingPrompt(projectId: string, conversationId: string, turnId: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/queue/${turnId}`, { method: "DELETE" });
}

export async function steerPendingPrompt(projectId: string, conversationId: string, turnId: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/queue/${turnId}/steer`, { method: "POST" });
}

export async function cancelPrompt(projectId: string, conversationId: string, turnId: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/turns/${turnId}/cancel`, { method: "POST" });
}

export function subscribeToProject(
  projectId: string,
  cursor: number,
  handlers: {
    onEvent: (event: RuntimeEvent) => void;
    onOpen: () => void;
    onError: () => void;
    onReset?: () => Promise<number>;
  },
): () => void {
  const controller = new AbortController();
  void streamProjectEvents(projectId, cursor, controller.signal, handlers);
  return () => controller.abort();
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...runtimeHeaders(),
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string };
  return new ApiError(body.message ?? body.error ?? `Request failed with ${response.status}`, response.status);
}

async function streamProjectEvents(
  projectId: string,
  initialCursor: number,
  signal: AbortSignal,
  handlers: {
    onEvent: (event: RuntimeEvent) => void;
    onOpen: () => void;
    onError: () => void;
    onReset?: () => Promise<number>;
  },
): Promise<void> {
  let cursor = initialCursor;
  while (!signal.aborted) {
    try {
      const response = await fetch(apiUrl(`/projects/${projectId}/events?cursor=${cursor}`), {
        headers: { accept: "text/event-stream", ...runtimeHeaders() },
        signal,
      });
      if (response.status === 409 && handlers.onReset) {
        cursor = await handlers.onReset();
        continue;
      }
      if (!response.ok || !response.body) {
        throw new ApiError(`Event stream failed with ${response.status}`, response.status);
      }
      handlers.onOpen();
      cursor = await consumeEventStream(response.body, cursor, handlers.onEvent, signal);
      if (!signal.aborted) handlers.onError();
    } catch {
      if (signal.aborted) return;
      handlers.onError();
    }
    await reconnectDelay(signal);
  }
}

async function streamModelAuthEvents(
  operationId: string,
  signal: AbortSignal,
  handlers: { onEvent: (event: ModelAuthEvent) => void; onError: () => void },
): Promise<void> {
  let cursor = 0;
  while (!signal.aborted) {
    try {
      const response = await fetch(apiUrl(`/settings/model-auth/${encodeURIComponent(operationId)}/events?cursor=${cursor}`), {
        headers: { accept: "text/event-stream", ...runtimeHeaders() },
        signal,
      });
      if (!response.ok || !response.body) throw new ApiError(`Authentication stream failed with ${response.status}`, response.status);
      const result = await consumeModelAuthStream(response.body, cursor, handlers.onEvent, signal);
      cursor = result.cursor;
      if (result.finished || signal.aborted) return;
    } catch {
      if (signal.aborted) return;
      handlers.onError();
    }
    await reconnectDelay(signal);
  }
}

async function consumeModelAuthStream(
  body: ReadableStream<Uint8Array>,
  initialCursor: number,
  onEvent: (event: ModelAuthEvent) => void,
  signal: AbortSignal,
): Promise<{ cursor: number; finished: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let cursor = initialCursor;
  let buffer = "";
  let finished = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseModelAuthEvent(block);
        if (!event) continue;
        cursor = Math.max(cursor, event.id);
        onEvent(event);
        if (event.type === "completed" || event.type === "cancelled" || event.type === "error") finished = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { cursor, finished };
}

async function consumeEventStream(
  body: ReadableStream<Uint8Array>,
  initialCursor: number,
  onEvent: (event: RuntimeEvent) => void,
  signal: AbortSignal,
): Promise<number> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let cursor = initialCursor;
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const event = parseRuntimeEvent(block);
        if (!event) continue;
        cursor = Math.max(cursor, event.id);
        onEvent(event);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return cursor;
}

function parseRuntimeEvent(block: string): RuntimeEvent | undefined {
  const fields = new Map<string, string[]>();
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const key = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).trimStart();
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  const type = fields.get("event")?.[0];
  const data = fields.get("data")?.join("\n");
  if (!type || !data || !RUNTIME_EVENT_TYPES.includes(type as (typeof RUNTIME_EVENT_TYPES)[number])) {
    return undefined;
  }
  try {
    return JSON.parse(data) as RuntimeEvent;
  } catch {
    return undefined;
  }
}

function parseModelAuthEvent(block: string): ModelAuthEvent | undefined {
  const data = block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data) as ModelAuthEvent;
  } catch {
    return undefined;
  }
}

function apiUrl(path: string): string {
  const runtime = desktopRuntime();
  return runtime ? `${runtime.daemonUrl}${path}` : `${API_BASE}${path}`;
}

function runtimeHeaders(): HeadersInit {
  const runtime = desktopRuntime();
  return runtime ? { authorization: `Bearer ${runtime.token}` } : {};
}

function modelRef(model: AgentModelRef): AgentModelRef {
  return { provider: model.provider, id: model.id };
}

function desktopRuntime(): DesktopRuntime | undefined {
  return window.ohMyGameDesktop?.runtime;
}

function reconnectDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 500);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
