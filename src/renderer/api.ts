import { diagnosticsFileName } from "../shared/diagnostics.js";
import type { StoryLibraryMediaResult, StoryUpgradeResult, StoryUpgradeStatus } from "../shared/story-web.js";
import { PROJECT_ARCHIVE_CONTENT_TYPE } from "../shared/project-archive.js";
import type { CommunityGameStats, CommunityGamesQuery, CommunityProfile } from "../shared/publish-v1.js";
import { runtimeConnection, subscribeRuntimeConnection } from "./runtime-connection.js";
import { assertWorkspaceVersion, observeWorkspaceVersion, workspaceVersion, type WorkspaceRequestInit } from "./workspace-version.js";
import type { DesktopRuntimeService } from "../shared/desktop-runtime.js";
import {
  RUNTIME_EVENT_TYPES,
  type AgentContextUsage,
  type AnswerQuestionnaireRequest,
  type AgentModelCatalog,
  type AgentModelRef,
  type AgentReasoningLevel,
  type CheckpointChangeItem,
  type CheckpointFileView,
  type CheckpointUndoRequest,
  type CheckpointUndoResponse,
  type ConversationAgentSettings,
  type ConversationCapabilities,
  type CreateLibraryImageRequest,
  type LibraryAsset,
  type LibraryAssetDerivation,
  type LibraryAssetPurpose,
  type LibraryAssetSummary,
  type LibraryUploadMediaType,
  type MediaModelDefaults,
  type ImageModel,
  type ImageModelCatalog,
  type ImageModelRef,
  type ModelAuthEvent,
  type ModelAuthMethod,
  type ModelProviderEndpointSettings,
  type OpenAIImageConnectionSettings,
  type SaveOpenAIImageConnectionRequest,
  type DiscoverOpenAIImageModelsRequest,
  type DiscoveredOpenAIImageModels,
  type ResponsesTransportSettings,
  type ResponsesTransportMode,
  type ProviderModelSettings,
  type Model3DDefinition,
  type CustomProviderModel,
  type CustomProviderDetails,
  type SaveCustomProviderRequest,
  type DiscoverProviderModelsRequest,
  type DiscoveredProviderModels,
  type ProviderSummary,
  type CreateProjectRequest,
  type CommunityGame,
  type ConversationDetail,
  type ConversationSummary,
  type ProjectRunSettings,
  type ProjectFileOpenMode,
  type ProjectActivitySnapshot,
  type ProjectCoverMode,
  type ProjectCoverState,
  type ProjectState,
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
  type MediaModelCatalog,
  type Model3DModel,
  type Model3DAnimationAction,
} from "../shared/contracts.js";
import type { AccountRuntimeId, AccountProfileIds, AgentAccountProfile, AgentAccountProfileStatus, AgentRuntimeId, AgentRuntimeLoginResponse, AgentRuntimeStatus, AnswerApprovalRequest, ApprovalDecision, UpdateAgentRuntimeRequest } from "../shared/agent-runtimes.js";
import type { AudioModelCatalog } from "../shared/audio.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import type { WorkspaceGitChanges, WorkspaceGitFileView } from "../shared/workspace-git.js";
import type { ExampleSummary } from "../shared/examples.js";
import type { PlaytestWatchState } from "../shared/playtest.js";
import type { NodeRuntimeResponse, NodeThumbnailResult, PlayableThumbnailSnapshot } from "../shared/playable-player-protocol.js";
import type { NodeCodebaseDetail, NodeCodebaseUpdate } from "../shared/playable-codebase.js";
import type { PlayableAddedNode, PlayablePresetSummary, PlayableProjectValidationResult as PlayableProjectValidation, PlayableThumbnailManifest } from "../shared/playable-editor.js";
import type { InstallPluginRequest, PluginCatalog, PluginDetail, PluginInstallInspection, PluginSettings, PluginSkillContent } from "../shared/plugins.js";
import type { UpdateWebSearchSettings, WebSearchSettings } from "../shared/web-search.js";
import type { ExternalAgentClientId, ExternalAgentSettings, UpdateExternalAgentSettings } from "../shared/external-mcp.js";
import type { DesktopClipboardFile } from "../shared/file-transfer.js";
import type { WebGamePlayerBridge } from "../shared/web-game-player.js";
import type { NetworkConnectionTest, NetworkSettings, NetworkSettingsState } from "../shared/network-settings.js";
import { composerDrafts } from "./composer-drafts.js";
import type { OnboardingState, UpdateOnboardingRequest } from "../shared/onboarding.js";
import { t } from "./i18n.js";

const API_BASE = "/api";

export function getOnboardingState(): Promise<OnboardingState> {
  return request("/settings/onboarding");
}

export function updateOnboardingState(state: UpdateOnboardingRequest): Promise<OnboardingState> {
  return request("/settings/onboarding", { method: "PUT", body: JSON.stringify(state) });
}

export function getNetworkSettings(): Promise<NetworkSettingsState> {
  return request("/settings/network");
}

export function updateNetworkSettings(settings: NetworkSettings): Promise<NetworkSettingsState> {
  return request("/settings/network", { method: "PUT", body: JSON.stringify(settings) });
}

export function detectNetworkProxy(): Promise<NetworkSettingsState> {
  return request("/settings/network/detect", { method: "POST" });
}

export function testNetworkConnection(settings: NetworkSettings): Promise<NetworkConnectionTest> {
  return request("/settings/network/test", { method: "POST", body: JSON.stringify(settings) });
}

interface DesktopRuntime {
  daemonUrl: string;
  token: string;
}

declare global {
  interface Window {
    ohMyGameDesktop?: {
      platform: string;
      runtime: DesktopRuntime;
      runtimeService?: DesktopRuntimeService;
      openExternal: (url: string) => Promise<void>;
      setAppearance: (appearance: "system" | "light" | "dark") => Promise<void>;
      restartApp?: () => Promise<void>;
      onPrepareClose?: (listener: () => Promise<void>) => () => void;
      onCancelClose?: (listener: (error: string) => void) => () => void;
      windowMenu?: {
        popup: (label: string, x: number, y: number) => Promise<void>;
      };
      openProjectFile: (projectId: string, filePath: string, mode?: ProjectFileOpenMode) => Promise<void>;
      browsePluginDirectory: (pluginId: string) => Promise<void>;
      revealPluginSkill: (pluginId: string, skillId: string) => Promise<void>;
      selectPluginDirectory: () => Promise<string | undefined>;
      selectProjectDirectory: () => Promise<string | undefined>;
      /** Older desktop builds do not write log files. */
      openLogsDirectory?: () => Promise<void>;
      /** Builds the diagnostics ZIP without the background service, for when it is not running. */
      exportDiagnostics?: () => Promise<Uint8Array<ArrayBuffer>>;
      clipboard: {
        files: () => Promise<DesktopClipboardFile[]>;
        paste: () => Promise<void>;
      };
      capturePage: (bounds: { x: number; y: number; width: number; height: number }) => Promise<Uint8Array>;
      /** Captures a Node's thumbnail in a hidden window, or says why it could not. */
      captureNodeThumbnail?: (projectId: string, nodeId: string, viewport: { width: number; height: number }, batchId: string) => Promise<NodeThumbnailResult>;
      /** Shares the editor build once, instead of compiling again for each capture. */
      prepareNodeThumbnails?: (projectId: string, batchId: string, snapshot: PlayableThumbnailSnapshot) => Promise<void>;
      /** Only a hidden thumbnail window can read its assigned snapshot. */
      nodeThumbnailSnapshot?: () => Promise<PlayableThumbnailSnapshot | undefined>;
      /** Cancels active and queued captures in a batch. */
      cancelNodeThumbnails?: (batchId: string) => Promise<void>;
      /** Called by the hidden thumbnail window once its capture is stored or failed. */
      finishNodeThumbnail?: (captured: boolean, error?: string) => Promise<void>;
      openPlaytest: (projectId: string, viewport: { width: number; height: number }) => Promise<void>;
      webGamePlayer?: WebGamePlayerBridge;
      /** Called from a Playtest window: shows the Node in the main window's editor. */
      openPlayableNode?: (projectId: string, nodeId: string) => Promise<void>;
      /** Called in the main window when a Playtest asks to open a Node. */
      onOpenPlayableNode?: (listener: (projectId: string, nodeId: string) => void) => () => void;
      /** Called from a Playtest window that cannot play: brings the project's editor forward. */
      showPlaytestEditor?: (projectId: string) => Promise<void>;
      /** Called in the main window when a Playtest asks for its project's editor. */
      onShowPlaytestEditor?: (listener: (projectId: string) => void) => () => void;
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

/** Follows project activity, reconnecting after a service restart; each connection starts with the current snapshot. */
export async function streamProjectActivity(signal: AbortSignal, onSnapshot: (snapshot: ProjectActivitySnapshot) => void): Promise<void> {
  while (!signal.aborted) {
    const connection = new AbortController();
    const unsubscribe = subscribeRuntimeConnection(() => connection.abort());
    const connectionSignal = AbortSignal.any([signal, connection.signal]);
    try {
      if (runtimeConnection().status !== "ready") throw new Error(t("api.serviceUnavailable"));
      const response = await fetch(apiUrl("/projects/activity/events"), {
        headers: { accept: "text/event-stream", ...runtimeHeaders() },
        signal: connectionSignal,
      });
      if (!response.ok || !response.body) throw new ApiError(`Activity stream failed with ${response.status}`, response.status);
      await readEventBlocks(response.body, (block) => {
        const data = eventData(block);
        if (data) onSnapshot(JSON.parse(data) as ProjectActivitySnapshot);
      }, connectionSignal);
    } catch {
      // Keep the last state during a temporary runtime disconnect.
    } finally {
      unsubscribe();
    }
    if (signal.aborted) return;
    await reconnectDelay(signal);
  }
}

export async function listExamples(): Promise<ExampleSummary[]> {
  return request("/examples");
}

export async function playExample(exampleId: string): Promise<{ url: string }> {
  return request(`/examples/${encodeURIComponent(exampleId)}/play`, { method: "POST" });
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

export async function updateProjectRunSettings(projectId: string, input: ProjectRunSettings): Promise<ProjectState> {
  return request(`/projects/${projectId}/settings/run`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function duplicateProject(projectId: string): Promise<ProjectState> {
  return request(`/projects/${projectId}/duplicate`, { method: "POST" });
}

/** Downloads the project as an archive that imports as a new project. */
export async function exportProject(projectId: string, version?: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/projects/${encodeURIComponent(projectId)}/export`), {
    method: "POST",
    headers: projectRuntimeHeaders(projectId, version),
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

/**
 * The name for a project file from earlier versions: its file name without
 * `.zip` and the "(project)" suffix the story export adds in either language.
 */
export function archiveProjectName(fileName: string): string {
  let name = fileName.replace(/\.zip$/i, "");
  for (const lng of ["en", "zh-CN"]) {
    const suffix = ` (${t("storySettings.projectFileSuffix", { lng })})`;
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name.slice(0, 255);
}

/** Creates a new project from an archive, streaming the file to the runtime. */
export async function importProject(file: File): Promise<ProjectState> {
  // Names a project file from earlier versions, which has no manifest.
  const query = new URLSearchParams({ name: archiveProjectName(file.name) });
  const response = await fetch(apiUrl(`/projects/import?${query}`), {
    method: "POST",
    headers: { "content-type": PROJECT_ARCHIVE_CONTENT_TYPE, ...runtimeHeaders() },
    body: file,
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<ProjectState>;
}

export async function deleteProject(projectId: string): Promise<void> {
  await request(`/projects/${projectId}`, { method: "DELETE" });
  composerDrafts.deleteProject(projectId);
}

/** Conversations list coding agents' models too; canvas text and other one-off generation use OhMyGame's own models only. */
export async function listModels(options: { agentRuntimes?: boolean; accountProfiles?: AccountProfileIds } = {}): Promise<AgentModelCatalog> {
  return request(options.agentRuntimes ? `/models?runtimes=1${options.accountProfiles ? `&profiles=${encodeURIComponent(JSON.stringify(options.accountProfiles))}` : ""}` : "/models");
}

export async function listAgentRuntimes(recheck = false): Promise<AgentRuntimeStatus[]> {
  return request(`/agent-runtimes${recheck ? "?recheck=1" : ""}`);
}

export async function updateAgentRuntime(id: AgentRuntimeId, change: UpdateAgentRuntimeRequest): Promise<AgentRuntimeStatus> {
  return request(`/agent-runtimes/${id}`, { method: "PATCH", body: JSON.stringify(change) });
}

export async function recheckAgentRuntime(id: AgentRuntimeId): Promise<AgentRuntimeStatus> {
  return request(`/agent-runtimes/${id}/recheck`, { method: "POST" });
}

export async function loginAgentRuntime(id: AgentRuntimeId, profileId?: string): Promise<AgentRuntimeLoginResponse> {
  return request(`/agent-runtimes/${id}/login${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ""}`, { method: "POST" });
}

export function listAccountProfiles(runtime: AccountRuntimeId, recheck = false): Promise<AgentAccountProfileStatus[]> {
  return request(`/agent-runtimes/${runtime}/profiles${recheck ? "?recheck=1" : ""}`);
}

export function addAccountProfile(runtime: AccountRuntimeId, name: string, configDirectory?: string): Promise<AgentAccountProfile> {
  return request(`/agent-runtimes/${runtime}/profiles`, { method: "POST", body: JSON.stringify({ name, ...(configDirectory ? { configDirectory } : {}) }) });
}

export function deleteAccountProfile(runtime: AccountRuntimeId, profileId: string): Promise<void> {
  return request(`/agent-runtimes/${runtime}/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
}

/** A model comes back when the chosen account does not offer the chat's model and the chat moved to one it does. */
export function setConversationAccountProfile(projectId: string, conversationId: string, runtime: AccountRuntimeId, profileId: string): Promise<{ profileId: string; model?: AgentModelRef; nativeReasoningLevel?: string }> {
  return request(`/projects/${projectId}/conversations/${conversationId}/account-profile`, { method: "PUT", body: JSON.stringify({ runtime, profileId }) });
}

export async function recheckCodexImages(): Promise<ProviderSummary> {
  return request("/settings/models/providers/codex-cli/images/recheck", { method: "POST" });
}

export async function answerApproval(projectId: string, conversationId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/approvals/${encodeURIComponent(requestId)}`, {
    method: "POST",
    body: JSON.stringify({ decision } satisfies AnswerApprovalRequest),
  });
}

export async function updateAgentDefaults(input: UpdateAgentDefaultsRequest): Promise<void> {
  await request("/models/default", {
    method: "PUT",
    body: JSON.stringify({ model: modelRef(input.model), reasoningLevel: input.reasoningLevel, ...(input.nativeReasoningLevel ? { nativeReasoningLevel: input.nativeReasoningLevel } : {}) }),
  });
}

export const MODELS_CHANGED_EVENT = "ohmygame-models-changed";
export async function syncCloudSession(session: { accessToken: string; userId: string } | null): Promise<void> {
  await request("/cloud/session", { method: "PUT", body: JSON.stringify(session) });
  notifyAgentModelsChanged();
}
export async function getCloudQuotas(): Promise<import("../shared/cloud-models.js").CloudQuotaSnapshot | null> { return request("/cloud/quotas"); }

export function notifyAgentModelsChanged(): void {
  window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
}

export async function listProviders(): Promise<ProviderSummary[]> {
  return request("/settings/providers");
}

export async function setProviderEnabled(providerId: string, enabled: boolean): Promise<ProviderSummary> {
  const result = await request<ProviderSummary>(`/settings/models/providers/${encodeURIComponent(providerId)}/enabled`, { method: "PATCH", body: JSON.stringify({ enabled }) });
  notifyAgentModelsChanged();
  return result;
}

export async function getOpenAIImageSettings(): Promise<OpenAIImageConnectionSettings> {
  return request("/settings/models/providers/openai/images");
}

export async function saveOpenAIImageSettings(settings: SaveOpenAIImageConnectionRequest): Promise<OpenAIImageConnectionSettings> {
  const saved = await request<OpenAIImageConnectionSettings>("/settings/models/providers/openai/images", { method: "PUT", body: JSON.stringify(settings) });
  notifyAgentModelsChanged();
  return saved;
}

export async function discoverOpenAIImageModels(settings: DiscoverOpenAIImageModelsRequest, signal?: AbortSignal): Promise<DiscoveredOpenAIImageModels> {
  return request("/settings/models/providers/openai/images/discover", { method: "POST", body: JSON.stringify(settings), signal });
}

export async function removeOpenAIImageSettings(): Promise<OpenAIImageConnectionSettings> {
  const saved = await request<OpenAIImageConnectionSettings>("/settings/models/providers/openai/images", { method: "DELETE" });
  notifyAgentModelsChanged();
  return saved;
}

export async function getCustomProvider(providerId: string): Promise<CustomProviderDetails> {
  return request(`/settings/models/providers/${encodeURIComponent(providerId)}/custom`);
}

export async function discoverCustomProviderModels(settings: DiscoverProviderModelsRequest, signal?: AbortSignal): Promise<DiscoveredProviderModels> {
  return request("/settings/models/providers/discover", { method: "POST", body: JSON.stringify(settings), signal });
}

export async function saveCustomProvider(settings: SaveCustomProviderRequest, providerId?: string): Promise<CustomProviderDetails> {
  const result = await request<CustomProviderDetails>(providerId ? `/settings/models/providers/${encodeURIComponent(providerId)}/custom` : "/settings/models/providers/custom", { method: providerId ? "PUT" : "POST", body: JSON.stringify(settings) });
  notifyAgentModelsChanged();
  return result;
}

export async function removeProvider(providerId: string): Promise<void> {
  await request(`/settings/models/providers/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  notifyAgentModelsChanged();
}

export async function refreshProviderModels(providerId: string): Promise<ProviderModelSettings> {
  const result = await request<ProviderModelSettings>(`/settings/models/providers/${encodeURIComponent(providerId)}/models/refresh`, { method: "POST" });
  notifyAgentModelsChanged();
  return result;
}

export async function getProviderModels(providerId: string): Promise<ProviderModelSettings> {
  return request(`/settings/models/providers/${encodeURIComponent(providerId)}/models`);
}

export async function setProviderModelVisibility(providerId: string, ids: string[], visible: boolean): Promise<ProviderModelSettings> {
  const result = await request<ProviderModelSettings>(`/settings/models/providers/${encodeURIComponent(providerId)}/models/visibility`, { method: "PUT", body: JSON.stringify({ ids, visible }) });
  notifyAgentModelsChanged();
  return result;
}

export async function addCustomProviderModel(providerId: string, model: CustomProviderModel | Model3DDefinition): Promise<ProviderModelSettings> {
  const result = await request<ProviderModelSettings>(`/settings/models/providers/${encodeURIComponent(providerId)}/models/custom`, { method: "POST", body: JSON.stringify(model) });
  notifyAgentModelsChanged();
  return result;
}

export async function updateProviderModel3D(providerId: string, model: Model3DDefinition): Promise<ProviderModelSettings> {
  const result = await request<ProviderModelSettings>(`/settings/models/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(model.id)}`, { method: "PUT", body: JSON.stringify(model) });
  notifyAgentModelsChanged();
  return result;
}

export async function resetProviderModel3D(providerId: string, modelId: string): Promise<ProviderModelSettings> {
  const result = await request<ProviderModelSettings>(`/settings/models/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/overrides`, { method: "DELETE" });
  notifyAgentModelsChanged();
  return result;
}

export async function removeCustomProviderModel(providerId: string, modelId: string): Promise<ProviderModelSettings> {
  const result = await request<ProviderModelSettings>(`/settings/models/providers/${encodeURIComponent(providerId)}/models/custom/${encodeURIComponent(modelId)}`, { method: "DELETE" });
  notifyAgentModelsChanged();
  return result;
}

export async function getOpenAIEndpointSettings(): Promise<ModelProviderEndpointSettings> {
  return request("/settings/models/providers/openai/endpoint");
}

export async function getResponsesTransport(provider: string): Promise<ResponsesTransportSettings> {
  return request(`/settings/models/providers/${encodeURIComponent(provider)}/transport`);
}
export async function updateResponsesTransport(provider: string, mode: ResponsesTransportMode): Promise<ResponsesTransportSettings> {
  return request(`/settings/models/providers/${encodeURIComponent(provider)}/transport`, { method: "PUT", body: JSON.stringify({ mode }) });
}

export async function updateOpenAIEndpointSettings(baseUrl: string): Promise<ModelProviderEndpointSettings> {
  return request("/settings/models/providers/openai/endpoint", {
    method: "PUT",
    body: JSON.stringify({ baseUrl }),
  });
}

export async function updateModel3DProviderApiKey(providerId: string, apiKey: string): Promise<{ configured: boolean }> {
  const result = await request<{ configured: boolean }>(`/settings/models/providers/${encodeURIComponent(providerId)}`, { method: "PUT", body: JSON.stringify({ apiKey }) });
  notifyAgentModelsChanged();
  return result;
}
export async function updateSeedanceApiKey(providerId: string, apiKey: string): Promise<{ configured: boolean }> {
  return request(`/settings/models/providers/${encodeURIComponent(providerId)}/seedance-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export async function updateMinimaxApiKey(providerId: string, apiKey: string): Promise<{ configured: boolean }> {
  return request(`/settings/models/providers/${encodeURIComponent(providerId)}/minimax-key`, {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
}

export async function updateVolcengineTtsApiKey(apiKey: string): Promise<{ configured: boolean; defaultVoiceId?: string }> {
  const result = await request<{ configured: boolean; defaultVoiceId?: string }>("/settings/models/providers/volcengine-tts", {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
  notifyAgentModelsChanged();
  return result;
}

export async function updateVolcengineSeedAudioApiKey(apiKey: string): Promise<{ configured: boolean }> {
  const result = await request<{ configured: boolean }>("/settings/models/providers/volcengine-seed-audio", {
    method: "PUT",
    body: JSON.stringify({ apiKey }),
  });
  notifyAgentModelsChanged();
  return result;
}

export async function saveVolcengineTtsDefaultVoiceId(defaultVoiceId: string | null): Promise<{ configured: boolean; defaultVoiceId?: string }> {
  return request<{ configured: boolean; defaultVoiceId?: string }>("/settings/models/providers/volcengine-tts", {
    method: "PUT",
    body: JSON.stringify(defaultVoiceId ? { defaultVoiceId } : { defaultVoiceId: null }),
  });
}

export interface VolcengineTtsPreviewInput {
  text: string;
  voiceId?: string;
  language?: string;
  style?: string;
  speed?: number;
}

export async function previewVolcengineTtsSpeech(input: VolcengineTtsPreviewInput): Promise<Blob> {
  const response = await fetch(apiUrl("/settings/models/providers/volcengine-tts/preview"), {
    method: "POST",
    headers: { "content-type": "application/json", ...runtimeHeaders() },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
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
export async function listImageModelCatalog(): Promise<ImageModelCatalog> {
  return request("/image-models/catalog");
}

export async function setDefaultMediaModel(usage: "image" | "video" | "3d", model?: AgentModelRef): Promise<void> {
  const endpoint = usage === "image" ? "/image-models/default" : usage === "video" ? "/video-models/default" : "/model3d-models/default";
  await request(endpoint, model ? { method: "PUT", body: JSON.stringify(model) } : { method: "DELETE" });
  notifyAgentModelsChanged();
}

export async function updateProjectMediaModelDefaults(projectId: string, defaults: MediaModelDefaults): Promise<ProjectState> {
  return request(`/projects/${encodeURIComponent(projectId)}/settings/generation-models`, { method: "PUT", body: JSON.stringify(defaults) });
}

export async function listVideoModelCatalog(): Promise<MediaModelCatalog<VideoModel>> {
  return request("/video-models/catalog");
}

export async function listAudioModelCatalog(): Promise<AudioModelCatalog> {
  return request("/audio-models/catalog");
}

export async function listModel3DCatalog(): Promise<MediaModelCatalog<Model3DModel>> {
  return request("/model3d-models/catalog");
}

/** Preset moves for rigged humanoids; empty until a 3D provider is set up. */
export async function listModel3DAnimations(model?: AgentModelRef, options?: import("../shared/contracts.js").Model3DOptions): Promise<Model3DAnimationAction[]> {
  const query = new URLSearchParams({ ...(model ? { provider: model.provider, id: model.id } : {}),
    ...(options?.rigModel ? { rigModel: options.rigModel } : {}), ...(options?.rigType ? { rigType: options.rigType } : {}) });
  return request(`/model3d-animations?${query}`);
}
export async function listModel3DOperations(): Promise<Model3DModel[]> { return request("/model3d-operations"); }
export async function model3DBalance(model: AgentModelRef): Promise<import("../shared/contracts.js").Model3DBalance> {
  return request(`/model3d-balance?${new URLSearchParams({ provider: model.provider, id: model.id })}`);
}

export async function getWebSearchSettings(): Promise<WebSearchSettings> {
  return request("/settings/web-search");
}

export async function updateWebSearchSettings(input: UpdateWebSearchSettings): Promise<WebSearchSettings> {
  return request("/settings/web-search", { method: "PUT", body: JSON.stringify(input) });
}

export async function getExternalAgentSettings(): Promise<ExternalAgentSettings> {
  return request("/settings/external-agents");
}

export async function updateExternalAgentSettings(input: UpdateExternalAgentSettings): Promise<ExternalAgentSettings> {
  return request("/settings/external-agents", { method: "PUT", body: JSON.stringify(input) });
}

export async function connectExternalAgent(id: ExternalAgentClientId): Promise<ExternalAgentSettings> {
  return request(`/settings/external-agents/clients/${id}`, { method: "PUT" });
}

export async function disconnectExternalAgent(id: ExternalAgentClientId): Promise<ExternalAgentSettings> {
  return request(`/settings/external-agents/clients/${id}`, { method: "DELETE" });
}

export async function listExploreGames(accessToken?: string, options: CommunityGamesQuery = {}): Promise<CommunityGame[]> {
  const query = new URLSearchParams({ metrics: "true" });
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.excludeGameId) query.set("excludeGameId", options.excludeGameId);
  return request(`/community/games?${query}`, { headers: communityHeaders(accessToken) });
}

export async function getExploreGame(gameId: string, accessToken?: string): Promise<CommunityGame> {
  return request(`/community/games/${encodeURIComponent(gameId)}?metrics=true`, { headers: communityHeaders(accessToken) });
}

export async function getExploreGameCover(gameId: string, deploymentId: string, accessToken?: string): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(
    `/community/games/${encodeURIComponent(gameId)}/deployments/${encodeURIComponent(deploymentId)}/cover`,
  ), { headers: { ...runtimeHeaders(), ...communityHeaders(accessToken) } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export function getCommunityProfile(authorId: string, accessToken?: string): Promise<CommunityProfile> {
  return request(`/community/authors/${encodeURIComponent(authorId)}`, { headers: communityHeaders(accessToken) });
}

export function getMyCommunityGames(accessToken: string): Promise<CommunityProfile> {
  return request("/community/me/games", { headers: communityHeaders(accessToken) });
}

export function setCommunityLike(gameId: string, accessToken: string | undefined, liked: boolean): Promise<CommunityGameStats> {
  return request(`/community/games/${encodeURIComponent(gameId)}/like`, { method: "PUT", body: JSON.stringify({ accessToken, liked }) });
}

export function unpublishCommunityGame(gameId: string, accessToken: string): Promise<void> {
  return request(`/community/games/${encodeURIComponent(gameId)}`, { method: "DELETE", body: JSON.stringify({ accessToken }) });
}

export function updateCommunityGame(gameId: string, accessToken: string, metadata: { title: string; description: string }): Promise<Pick<CommunityGame, "title" | "description">> {
  return request(`/community/games/${encodeURIComponent(gameId)}`, { method: "PUT", body: JSON.stringify({ accessToken, ...metadata }) });
}

function communityHeaders(accessToken?: string): Record<string, string> {
  return accessToken ? { "x-publish-access-token": accessToken } : {};
}

export async function listPlugins(): Promise<PluginCatalog> {
  return request("/plugins");
}

export async function getHomeComposerCapabilities(): Promise<ConversationCapabilities> {
  return request("/composer/capabilities");
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

/**
 * A ZIP of the redacted desktop logs and system information, for bug reports.
 * When the background service cannot build it, the desktop app builds one
 * with the logs and the service's status.
 */
export async function exportDiagnostics(): Promise<{ blob: Blob; fileName: string }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(apiUrl("/diagnostics/export"), { method: "POST", headers: runtimeHeaders(), signal: controller.signal });
    if (!response.ok) throw await responseError(response);
    const fileName = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
    return { blob: await response.blob(), fileName: fileName ?? diagnosticsFileName(new Date()) };
  } catch (cause) {
    const desktopExport = window.ohMyGameDesktop?.exportDiagnostics;
    if (!desktopExport) throw cause;
    const bytes = await desktopExport();
    return { blob: new Blob([bytes], { type: "application/zip" }), fileName: diagnosticsFileName(new Date()) };
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function buildInteractiveStory(projectId: string, version?: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/projects/${projectId}/interactive-story/build`), {
    method: "POST",
    headers: projectRuntimeHeaders(projectId, version),
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
  throw new Error(t("api.runtimeUnreachable"));
}

export async function getProject(projectId: string): Promise<ProjectState> {
  return request(`/projects/${projectId}`);
}

export async function ensureProjectPreview(projectId: string): Promise<{ url: string; title: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/preview?reuse=1`, { method: "POST" });
}

/** Whether an Interactive Story plays as its own page, or must be upgraded first. */
export async function getStoryUpgrade(projectId: string): Promise<StoryUpgradeStatus> {
  return request(`/projects/${projectId}/interactive-story/upgrade`);
}

export async function upgradeStory(projectId: string): Promise<StoryUpgradeResult> {
  return request(`/projects/${projectId}/interactive-story/upgrade`, { method: "POST" });
}

export async function copyStoryLibraryMedia(projectId: string): Promise<StoryLibraryMediaResult> {
  return request(`/projects/${projectId}/interactive-story/library-media`, { method: "POST" });
}

export async function getNodeRuntime(projectId: string): Promise<NodeRuntimeResponse> {
  return request(`/projects/${projectId}/playable`);
}

export async function getNodeCodebase(projectId: string): Promise<NodeCodebaseDetail> {
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
  version?: string,
): Promise<PlayableAddedNode> {
  return request(`/projects/${projectId}/playable/nodes`, {
    method: "POST",
    body: JSON.stringify(body),
    workspaceVersion: version,
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

export async function setPlayableThumbnail(projectId: string, nodeId: string, hash: string, image: Blob, version?: string): Promise<void> {
  const response = await fetch(apiUrl(`/projects/${projectId}/playable/thumbnails/${encodeURIComponent(nodeId)}?hash=${encodeURIComponent(hash)}`), {
    method: "PUT",
    headers: { "content-type": "image/webp", ...projectRuntimeHeaders(projectId, version) },
    body: image,
  });
  if (!response.ok) throw await responseError(response);
}

/** Rejects with status 409 when the project changed since `codebase.revision` was read. */
export async function updateNodeCodebase(
  projectId: string,
  codebase: NodeCodebaseUpdate & { revision: string },
  version?: string,
): Promise<{ revision: string }> {
  return request(`/projects/${projectId}/playable/codebase`, {
    method: "PUT",
    workspaceVersion: version,
    body: JSON.stringify(codebase),
  });
}

export async function getProjectCover(projectId: string): Promise<Blob | undefined> {
  const response = await fetch(apiUrl(`/projects/${projectId}/cover`), { headers: runtimeHeaders() });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function getProjectCoverState(projectId: string): Promise<ProjectCoverState> {
  return request(`/projects/${projectId}/cover/state`);
}

export async function setProjectCover(projectId: string, cover: Blob, source: ProjectCoverMode = "custom"): Promise<void> {
  const suffix = source === "auto" ? "?source=auto" : "";
  const response = await fetch(apiUrl(`/projects/${projectId}/cover${suffix}`), {
    method: "PUT",
    headers: { "content-type": "image/webp", ...projectRuntimeHeaders(projectId) },
    body: cover,
  });
  if (!response.ok) throw await responseError(response);
}

export async function setProjectCoverMode(projectId: string, mode: ProjectCoverMode): Promise<void> {
  await request(`/projects/${projectId}/cover/state`, { method: "PUT", body: JSON.stringify({ mode }) });
}

export async function listWorkspaceFiles(projectId: string): Promise<WorkspaceFile[]> {
  return request(`/projects/${projectId}/files`);
}

export async function getWorkspaceGitChanges(projectId: string): Promise<WorkspaceGitChanges> {
  return request(`/projects/${encodeURIComponent(projectId)}/git/changes`);
}

export async function getWorkspaceGitFile(projectId: string, filePath: string): Promise<WorkspaceGitFileView> {
  return request(`/projects/${encodeURIComponent(projectId)}/git/file?path=${encodeURIComponent(filePath)}`);
}

export async function createWorkspaceEntry(projectId: string, parent: string, name: string, kind: "file" | "folder"): Promise<{ path: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/files`, { method: "POST", body: JSON.stringify({ parent, name, kind }) });
}

export async function renameWorkspaceEntry(projectId: string, filePath: string, name: string): Promise<{ path: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(filePath)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function deleteWorkspaceEntry(projectId: string, filePath: string): Promise<void> {
  await request(`/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
}

export async function saveProjectAssetToLibrary(projectId: string, filePath: string): Promise<LibraryAsset> {
  return request(`/projects/${encodeURIComponent(projectId)}/assets/library?path=${encodeURIComponent(filePath)}`, { method: "POST" });
}

export async function saveLibraryAsset(assetId: string): Promise<LibraryAsset> {
  return request(`/library/assets/${encodeURIComponent(assetId)}/save`, { method: "POST" });
}

export async function listLibraryAssets(): Promise<LibraryAssetSummary[]> {
  return request("/library/assets");
}

export async function createLibraryImage(input: CreateLibraryImageRequest): Promise<LibraryAsset> {
  return request("/library/assets", { method: "POST", body: JSON.stringify(input) });
}

/** `derivedFrom` records the Library video an upload was cut from. */
export async function uploadLibraryAsset(file: File, mediaType: LibraryUploadMediaType, duration?: number, purpose?: LibraryAssetPurpose, derivedFrom?: LibraryAssetDerivation): Promise<LibraryAsset> {
  const query = new URLSearchParams({ name: file.name, mediaType });
  if (duration !== undefined) query.set("duration", String(duration));
  if (purpose !== undefined) query.set("purpose", purpose);
  if (derivedFrom) {
    query.set("trimSource", derivedFrom.assetId);
    query.set("trimStart", String(derivedFrom.trim.start));
    query.set("trimEnd", String(derivedFrom.trim.end));
  }
  return request(`/library/assets/upload?${query}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

/** Copies a file that is not a document, table or media asset into the project's `assets/files/` folder. */
export async function importCanvasFile(projectId: string, file: File, directory?: string): Promise<{ path: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/canvas/files?${new URLSearchParams({ name: file.name, ...(directory ? { directory } : {}) })}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
}

/** Creates an `assets/files/` folder for a folder imported on the canvas; a repeated name gets a suffix. */
export async function createCanvasImportFolder(projectId: string, name: string): Promise<{ path: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/canvas/folders`, { method: "POST", body: JSON.stringify({ name }) });
}

export async function getLibraryAsset(assetId: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/library/assets/${encodeURIComponent(assetId)}/content`), { headers: runtimeHeaders() });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

/** Copies a Library asset into the project's `assets/imported/` folder; sending the same asset again returns the existing file. */
export async function addLibraryAssetToProject(projectId: string, assetId: string): Promise<{ path: string; assetId: string }> {
  return request(`/projects/${encodeURIComponent(projectId)}/library-assets/${encodeURIComponent(assetId)}`, { method: "POST" });
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

export async function getConversationImage(url: string, signal?: AbortSignal): Promise<Blob> {
  if (!/^\/projects\/[^/]+\/conversation-images\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(url)) {
    throw new Error("Invalid conversation image reference");
  }
  const response = await fetch(apiUrl(url), { headers: runtimeHeaders(), signal });
  if (!response.ok) throw await responseError(response);
  return response.blob();
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

export async function branchConversation(projectId: string, conversationId: string, entryId: string): Promise<ConversationSummary> {
  return request(`/projects/${projectId}/conversations/${conversationId}/branch`, { method: "POST", body: JSON.stringify({ entryId }) });
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

export function setConversationReasoning(projectId: string, conversationId: string, level: AgentReasoningLevel): Promise<AgentReasoningLevel>;
export function setConversationReasoning(projectId: string, conversationId: string, level: string): Promise<string>;
export async function setConversationReasoning(projectId: string, conversationId: string, level: string): Promise<string> {
  const result = await request<{ level: string }>(`/projects/${projectId}/conversations/${conversationId}/reasoning`, {
    method: "PUT",
    body: JSON.stringify({ level }),
  });
  return result.level;
}

export async function startPreview(projectId: string, reinstall = false): Promise<{ url: string }> {
  return request(`/projects/${projectId}/preview${reinstall ? "?reinstall=1" : ""}`, { method: "POST" });
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
    headers: { "content-type": "application/vnd.ohmygame.attachment", ...projectRuntimeHeaders(projectId) },
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

/** Lists the files the turn of the checkpoint's message changed. */
export async function getCheckpointChanges(projectId: string, conversationId: string, checkpointId: string): Promise<CheckpointChangeItem[]> {
  const { changes } = await request<{ changes: CheckpointChangeItem[] }>(`/projects/${projectId}/conversations/${conversationId}/checkpoints/${encodeURIComponent(checkpointId)}/changes`);
  return changes;
}

/** Reads one of those files as it was before the turn and as the turn left it. */
export async function getCheckpointFile(projectId: string, conversationId: string, checkpointId: string, filePath: string): Promise<CheckpointFileView> {
  return request(`/projects/${projectId}/conversations/${conversationId}/checkpoints/${encodeURIComponent(checkpointId)}/file?path=${encodeURIComponent(filePath)}`);
}

/**
 * Takes back the file changes of one turn and keeps the conversation. Without
 * `conflicts` it rejects with status 409 and the paths in `ApiError.conflicts`
 * when files were changed again after the turn. To overwrite them, `expected`
 * names the paths the user was shown; it rejects the same way when other files
 * were changed by now.
 */
export async function undoCheckpoint(projectId: string, conversationId: string, checkpointId: string, conflicts?: CheckpointUndoRequest["conflicts"], expected?: string[]): Promise<CheckpointUndoResponse> {
  return changeCheckpointFiles("undo", projectId, conversationId, checkpointId, conflicts, expected);
}

/** Reapplies only undone paths, with the same conflict checks as Undo. */
export async function reapplyCheckpoint(projectId: string, conversationId: string, checkpointId: string, conflicts?: CheckpointUndoRequest["conflicts"], expected?: string[]): Promise<CheckpointUndoResponse> {
  return changeCheckpointFiles("reapply", projectId, conversationId, checkpointId, conflicts, expected);
}

function changeCheckpointFiles(direction: "undo" | "reapply", projectId: string, conversationId: string, checkpointId: string, conflicts?: CheckpointUndoRequest["conflicts"], expected?: string[]): Promise<CheckpointUndoResponse> {
  return request(`/projects/${projectId}/conversations/${conversationId}/checkpoints/${encodeURIComponent(checkpointId)}/${direction}`, {
    method: "POST",
    body: JSON.stringify({ conflicts, expected } satisfies CheckpointUndoRequest),
  });
}

/** Whether a restore or an undo was cut off and may have left the project's files partly changed. */
export async function getUnfinishedRestore(projectId: string): Promise<boolean> {
  const { unfinished } = await request<{ unfinished: boolean }>(`/projects/${projectId}/checkpoints/unfinished`);
  return unfinished;
}

/**
 * Lists what putting the files back after a restore or an undo that was cut
 * off would do: "added" brings a file back, "removed" takes it away. The
 * items say nothing about how a file stands.
 */
export async function getUnfinishedChanges(projectId: string): Promise<CheckpointChangeItem[]> {
  const { changes } = await request<{ changes: CheckpointChangeItem[] }>(`/projects/${projectId}/checkpoints/unfinished/changes`);
  return changes;
}

/** Puts the files back as they were before the restore or undo that was cut off. */
export async function restoreUnfinished(projectId: string): Promise<void> {
  return request(`/projects/${projectId}/checkpoints/unfinished/restore`, { method: "POST" });
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
    readonly code?: string,
    /** The workspace paths the request was refused for. */
    readonly conflicts?: string[],
    /** Those paths cannot be put back, whatever the request says to do with them. */
    readonly blocked?: boolean,
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init: WorkspaceRequestInit = {}): Promise<T> {
  const projectId = /^\/projects\/([^/?]+)/.exec(path)?.[1];
  const observedVersion = projectId ? workspaceVersion(projectId) : undefined;
  if (projectId && init.workspaceVersion !== undefined) assertWorkspaceVersion(projectId, init.workspaceVersion);
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...runtimeHeaders(),
      ...(projectId ? { "x-workspace-version": init.workspaceVersion ?? observedVersion! } : {}),
      ...init.headers,
    },
  });
  const version = response.headers.get("x-workspace-version");
  if (projectId && version && (!init.method || init.method === "GET") && workspaceVersion(projectId) === observedVersion) observeWorkspaceVersion(projectId, version);
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string; code?: string; conflicts?: unknown; blocked?: unknown };
  const conflicts = Array.isArray(body.conflicts) && body.conflicts.every((path) => typeof path === "string") ? body.conflicts as string[] : undefined;
  return new ApiError(body.message ?? body.error ?? t("api.requestFailed", { status: response.status }), response.status, body.code, conflicts, body.blocked === true || undefined);
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
  let generation = runtimeConnection().generation;
  while (!signal.aborted) {
    const connection = new AbortController();
    const unsubscribe = subscribeRuntimeConnection(() => connection.abort());
    const connectionSignal = AbortSignal.any([signal, connection.signal]);
    try {
      const current = runtimeConnection();
      if (current.status !== "ready") throw new Error(t("api.serviceUnavailable"));
      if (current.generation !== generation) {
        generation = current.generation;
        cursor = handlers.onReset ? await handlers.onReset() : 0;
      }
      const response = await fetch(apiUrl(`/projects/${projectId}/events?cursor=${cursor}`), {
        headers: { accept: "text/event-stream", ...runtimeHeaders() },
        signal: connectionSignal,
      });
      if (response.status === 409 && handlers.onReset) {
        cursor = await handlers.onReset();
        continue;
      }
      if (!response.ok || !response.body) {
        throw new ApiError(`Event stream failed with ${response.status}`, response.status);
      }
      handlers.onOpen();
      await readEventBlocks(response.body, (block) => {
        const event = parseRuntimeEvent(block);
        if (!event || event.id <= cursor) return;
        cursor = Math.max(cursor, event.id);
        handlers.onEvent(event);
      }, connectionSignal);
      if (!signal.aborted) handlers.onError();
    } catch {
      if (signal.aborted) return;
      handlers.onError();
    }
    finally { unsubscribe(); }
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
      let finished = false;
      await readEventBlocks(response.body, (block) => {
        const event = parseModelAuthEvent(block);
        if (!event) return;
        if (event.type === "completed" || event.type === "cancelled" || event.type === "error") finished = true;
        if (event.id <= cursor) return;
        cursor = Math.max(cursor, event.id);
        handlers.onEvent(event);
      }, signal);
      if (finished || signal.aborted) return;
    } catch {
      if (signal.aborted) return;
      handlers.onError();
    }
    await reconnectDelay(signal);
  }
}

/** Passes each complete event of a server-sent event stream until it ends or the signal aborts. */
async function readEventBlocks(body: ReadableStream<Uint8Array>, onBlock: (block: string) => void, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (signal.aborted) return;
        onBlock(block);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function eventData(block: string): string {
  return block.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
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
  const data = eventData(block);
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

function projectRuntimeHeaders(projectId: string, version = workspaceVersion(projectId)): HeadersInit {
  assertWorkspaceVersion(projectId, version);
  return { ...runtimeHeaders(), "x-workspace-version": version };
}

function runtimeHeaders(): HeadersInit {
  const runtime = desktopRuntime();
  return runtime ? { authorization: `Bearer ${runtime.token}` } : {};
}

function modelRef(model: AgentModelRef): AgentModelRef {
  return { provider: model.provider, id: model.id };
}

function desktopRuntime(): DesktopRuntime | undefined {
  const desktop = window.ohMyGameDesktop;
  if (!desktop) return;
  const state = runtimeConnection();
  if (state.status !== "ready") throw new Error(t("api.serviceUnavailableLong"));
  return state.runtime ? { daemonUrl: state.runtime.url, token: state.runtime.token } : desktop.runtime;
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

export async function createMcpPlugin(input: import("../shared/plugins.js").CreateMcpPluginRequest): Promise<PluginDetail> {
  return request("/plugins/mcp", { method: "POST", body: JSON.stringify(input) });
}
export async function readPluginConfiguration(id: string): Promise<import("../shared/plugins.js").PluginConfigurationView> {
  return request(`/plugins/${encodeURIComponent(id)}/configuration`);
}
export async function savePluginConfiguration(id: string, values: import("../shared/plugins.js").PluginConfigurationValues): Promise<import("../shared/plugins.js").PluginConfigurationView> {
  return request(`/plugins/${encodeURIComponent(id)}/configuration`, { method: "PUT", body: JSON.stringify({ values }) });
}
export async function testPluginMcp(id: string, server: string, action: "test" | "auth-start" | "auth-complete" = "test", input?: string): Promise<import("../shared/plugins.js").PluginMcpResult> {
  return request(`/plugins/${encodeURIComponent(id)}/mcp/${encodeURIComponent(server)}/${action}`, { method: "POST", body: JSON.stringify(input ? { input } : {}) });
}
export async function createPluginSetup(pluginId?: string, mode?: import("../shared/plugin-setup.js").PluginSetupMode): Promise<import("../shared/plugin-setup.js").PluginSetupState> {
  return request("/plugins/setup-sessions", { method: "POST", body: JSON.stringify({ pluginId, mode }) });
}
export async function exportPluginArchive(id: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/plugins/${encodeURIComponent(id)}/export`), { headers: runtimeHeaders() });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
export async function inspectPluginArchive(file: Blob): Promise<import("../shared/plugin-portability.js").PluginArchivePreview> {
  return uploadPluginArchive("/plugins/import/inspect", file);
}
export async function restorePluginArchive(file: Blob, revision?: string): Promise<PluginDetail> {
  return uploadPluginArchive(`/plugins/import${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`, file);
}
async function uploadPluginArchive<T>(route: string, file: Blob): Promise<T> {
  const response = await fetch(apiUrl(route), { method: "POST", headers: { "content-type": "application/zip", ...runtimeHeaders() }, body: file });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}
export async function checkPluginDependencies(id: string): Promise<import("../shared/plugin-portability.js").PluginDiagnostics> {
  return request(`/plugins/${encodeURIComponent(id)}/dependencies`);
}
export async function clearPluginSetupConversation(id: string): Promise<import("../shared/plugin-setup.js").PluginSetupState> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/conversation`, { method: "DELETE" });
}
export async function readPluginSetup(id: string): Promise<import("../shared/plugin-setup.js").PluginSetupState> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}`);
}
export async function deletePluginSetup(id: string): Promise<void> {
  await request(`/plugins/setup-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function promptPluginSetup(id: string, prompt: string, model: AgentModelRef, reasoningLevel?: import("../shared/contracts.js").AgentReasoningLevel): Promise<import("../shared/plugin-setup.js").PluginSetupState> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/prompt`, { method: "POST", body: JSON.stringify({ prompt, model, reasoningLevel }) });
}
export async function abortPluginSetup(id: string): Promise<void> {
  await request(`/plugins/setup-sessions/${encodeURIComponent(id)}/abort`, { method: "POST" });
}

export async function listPluginSetups(): Promise<import("../shared/plugin-setup.js").PluginSetupSummary[]> {
  return request("/plugins/setup-sessions");
}
export async function readPluginDraft(id: string): Promise<import("../shared/plugin-setup.js").PluginDraft> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/draft`);
}
export function updatePluginDraftIcon(id: string, input: import("../shared/plugin-setup.js").PluginIconUpdate): Promise<import("../shared/plugin-setup.js").PluginDraft> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/icon`, { method: "PUT", body: JSON.stringify(input) });
}
export async function readPluginIconImage(pluginId: string, setupId?: string, signal?: AbortSignal, previewPath?: string): Promise<Blob> {
  const route = setupId ? `/plugins/setup-sessions/${encodeURIComponent(setupId)}/icon` : `/plugins/${encodeURIComponent(pluginId)}/icon`;
  const suffix = setupId && previewPath ? `?${new URLSearchParams({ path: previewPath })}` : "";
  const response = await fetch(apiUrl(`${route}${suffix}`), { headers: runtimeHeaders(), signal });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
export async function readPluginDraftFile(id: string, path: string): Promise<{ path: string; content: string }> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/file?${new URLSearchParams({ path })}`);
}
export async function installPluginDraft(id: string, revision: string): Promise<import("../shared/plugin-setup.js").PluginSetupState> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/install`, { method: "POST", body: JSON.stringify({ revision }) });
}
export async function readPluginDraftConfiguration(id: string): Promise<import("../shared/plugins.js").PluginConfigurationView> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/configuration`);
}
export async function savePluginDraftConfiguration(id: string, values: import("../shared/plugins.js").PluginConfigurationValues): Promise<import("../shared/plugins.js").PluginConfigurationView> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/configuration`, { method: "PUT", body: JSON.stringify({ values }) });
}
export async function testPluginDraft(id: string, server: string, revision: string): Promise<import("../shared/plugins.js").PluginMcpResult> {
  return request(`/plugins/setup-sessions/${encodeURIComponent(id)}/test/${encodeURIComponent(server)}`, { method: "POST", body: JSON.stringify({ revision }) });
}
export async function readPluginMcpDefinition(id: string, server: string): Promise<{ definition: import("../shared/plugins.js").McpServerDefinition }> {
  return request(`/plugins/${encodeURIComponent(id)}/mcp/${encodeURIComponent(server)}/definition`);
}
export async function savePluginMcpDefinition(id: string, server: string, definition: import("../shared/plugins.js").McpServerDefinition): Promise<PluginDetail> {
  return request(`/plugins/${encodeURIComponent(id)}/mcp/${encodeURIComponent(server)}/definition`, { method: "PUT", body: JSON.stringify({ definition }) });
}

export async function stopPreview(projectId: string): Promise<{ preview: ProjectState["preview"] }> {
  return request(`/projects/${projectId}/preview`, { method: "DELETE" });
}
export async function acquirePreview(projectId: string, leaseId: string, automatic = false, paused = false): Promise<void> {
  await request(`/projects/${projectId}/preview/leases/${leaseId}`, { method: "PUT", body: JSON.stringify({ automatic, paused }) });
}
export async function releasePreview(projectId: string, leaseId: string): Promise<void> {
  await request(`/projects/${projectId}/preview/leases/${leaseId}`, { method: "DELETE" });
}
export async function inspectProjectPreview(projectId: string, settings: ProjectRunSettings): Promise<{ mode?: string; manager?: string; source?: string; error?: string }> {
  return request(`/projects/${projectId}/preview/inspect`, { method: "POST", body: JSON.stringify(settings) });
}

export function getPluginIntegration(pluginId: string, projectId?: string): Promise<import("../shared/plugin-integration.js").PluginIntegrationState> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/integration${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
}
export function runPluginIntegration(pluginId: string, action: import("../shared/plugin-integration.js").PluginIntegrationAction, projectId?: string, remoteProjectId?: string): Promise<import("../shared/plugin-integration.js").PluginIntegrationState> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/integration${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { method: "POST", body: JSON.stringify({ action, ...(remoteProjectId ? { projectId: remoteProjectId } : {}) }) });
}
export function cancelPluginIntegration(pluginId: string, projectId?: string): Promise<{ ok: true }> {
  return request(`/plugins/${encodeURIComponent(pluginId)}/integration${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { method: "DELETE" });
}
export function clearProjectIntegration(projectId: string): Promise<ProjectState> {
  return request(`/projects/${encodeURIComponent(projectId)}/integration`, { method: "DELETE" });
}
export function setProjectIntegration(projectId: string, pluginId: string): Promise<ProjectState> {
  return request(`/projects/${encodeURIComponent(projectId)}/integration`, { method: "PUT", body: JSON.stringify({ pluginId }) });
}

export interface DoubaoVoiceConnection { ttsConfigured: boolean; seedConfigured: boolean; distinctKeys: boolean; defaultVoiceId?: string }
export function getDoubaoVoiceSettings(): Promise<DoubaoVoiceConnection> { return request("/settings/models/providers/doubao-voice"); }
export async function updateDoubaoVoiceApiKey(apiKey: string): Promise<DoubaoVoiceConnection> {
  const result = await request<DoubaoVoiceConnection>("/settings/models/providers/doubao-voice", { method: "PUT", body: JSON.stringify({ apiKey }) });
  notifyAgentModelsChanged(); return result;
}
export async function previewSeedAudio(prompt: string): Promise<Blob> {
  const response = await fetch(apiUrl("/settings/models/providers/volcengine-seed-audio/preview"), { method: "POST", headers: { ...runtimeHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ prompt, durationSeconds: 2 }) });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}
