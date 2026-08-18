import {
  RUNTIME_EVENT_TYPES,
  type AddedProjectAsset,
  type AddToolResultRequest,
  type AgentModelCatalog,
  type AgentModelRef,
  type AgentReasoningLevel,
  type ConversationAgentSettings,
  type ImageGenerationSettings,
  type ModelAuthEvent,
  type ModelAuthMethod,
  type Model3DGenerationSettings,
  type ModelProviderEndpointSettings,
  type ModelProviderSummary,
  type CreateProjectRequest,
  type CommunityGame,
  type ConversationDetail,
  type ConversationState,
  type ConversationSummary,
  type ProjectState,
  type PublishProjectRequest,
  type PublishResult,
  type RuntimeEvent,
  type RunToolRequest,
  type ToolDefinition,
  type ToolRun,
  type ToolSettings,
  type UpdateImageGenerationSettings,
  type UpdateModel3DGenerationSettings,
  type PromptImage,
  type PromptReference,
  type PromptResponse,
  type WorkspaceFile,
  type WorkspaceFileContent,
} from "../shared/contracts.js";

const API_BASE = "/api";

interface DesktopRuntime {
  daemonUrl: string;
  token: string;
}

declare global {
  interface Window {
    openGameDesktop?: {
      platform: string;
      runtime: DesktopRuntime;
      openExternal: (url: string) => Promise<void>;
      capturePage: (bounds: { x: number; y: number; width: number; height: number }) => Promise<Uint8Array>;
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

export async function renameProject(projectId: string, name: string): Promise<ProjectState> {
  return request(`/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ name }) });
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

export async function listModelProviders(): Promise<ModelProviderSummary[]> {
  return request("/settings/models/providers");
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

export async function getImageGenerationSettings(): Promise<ImageGenerationSettings> {
  return request("/settings/image-generation");
}

export async function updateImageGenerationSettings(input: UpdateImageGenerationSettings): Promise<ImageGenerationSettings> {
  return request("/settings/image-generation", { method: "PUT", body: JSON.stringify(input) });
}

export async function getModel3DGenerationSettings(): Promise<Model3DGenerationSettings> {
  return request("/settings/model-3d-generation");
}

export async function updateModel3DGenerationSettings(input: UpdateModel3DGenerationSettings): Promise<Model3DGenerationSettings> {
  return request("/settings/model-3d-generation", { method: "PUT", body: JSON.stringify(input) });
}

export async function listCommunityGames(): Promise<CommunityGame[]> {
  return request("/community/games");
}

export async function getCommunityGame(gameId: string): Promise<CommunityGame> {
  return request(`/community/games/${encodeURIComponent(gameId)}`);
}

export async function listTools(): Promise<ToolDefinition[]> {
  return request("/tools");
}

export async function getToolSettings(): Promise<ToolSettings> {
  return request("/tool-settings");
}

export async function updateToolSettings(settings: ToolSettings): Promise<ToolSettings> {
  return request("/tool-settings", { method: "PUT", body: JSON.stringify(settings) });
}

export async function runTool(toolId: ToolDefinition["id"], input: RunToolRequest): Promise<ToolRun> {
  return request(`/tools/${toolId}/runs`, { method: "POST", body: JSON.stringify(input) });
}

export async function getToolRunFile(runId: string, fileName: string): Promise<Blob> {
  const response = await fetch(apiUrl(`/tool-runs/${runId}/files/${encodeURIComponent(fileName)}`), {
    headers: runtimeHeaders(),
  });
  if (!response.ok) throw await responseError(response);
  return response.blob();
}

export async function addToolResultToProject(
  projectId: string,
  input: AddToolResultRequest,
): Promise<AddedProjectAsset> {
  return request(`/projects/${projectId}/tool-results`, { method: "POST", body: JSON.stringify(input) });
}

export async function publishProject(projectId: string, accessToken: string): Promise<PublishResult> {
  const body: PublishProjectRequest = { accessToken };
  return request(`/projects/${projectId}/publish`, { method: "POST", body: JSON.stringify(body) });
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
): Promise<ConversationState> {
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
): Promise<PromptResponse> {
  return request(`/projects/${projectId}/conversations/${conversationId}/turns`, {
    method: "POST",
    body: JSON.stringify({ prompt, ...(references.length ? { references } : {}), ...(images.length ? { images } : {}) }),
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
  return new ApiError(body.error ?? body.message ?? `Request failed with ${response.status}`, response.status);
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
  return window.openGameDesktop?.runtime;
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
