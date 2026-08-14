import {
  RUNTIME_EVENT_TYPES,
  type AddedProjectAsset,
  type AddToolResultRequest,
  type AgentModelCatalog,
  type AgentModelRef,
  type CreateProjectRequest,
  type CommunityGame,
  type ConversationDetail,
  type ConversationState,
  type ConversationSummary,
  type ProjectState,
  type PublishResult,
  type RuntimeEvent,
  type RunImageToolRequest,
  type ToolDefinition,
  type ToolRun,
  type ToolSettings,
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
      runtime: DesktopRuntime;
    };
  }
}

export async function createProject(input: CreateProjectRequest = {}): Promise<ProjectState> {
  return request("/projects", { method: "POST", body: JSON.stringify(input) });
}

export async function listProjects(): Promise<ProjectState[]> {
  return request("/projects");
}

export async function listModels(): Promise<AgentModelCatalog> {
  return request("/models");
}

export async function listCommunityGames(): Promise<CommunityGame[]> {
  return request("/community/games");
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

export async function runTool(toolId: ToolDefinition["id"], input: RunImageToolRequest): Promise<ToolRun> {
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

export async function publishProject(projectId: string): Promise<PublishResult> {
  return request(`/projects/${projectId}/publish`, { method: "POST" });
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

export async function createConversation(projectId: string, model?: AgentModelRef): Promise<ConversationState> {
  return request(`/projects/${projectId}/conversations`, {
    method: "POST",
    body: JSON.stringify(model ? { model } : {}),
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
): Promise<AgentModelRef> {
  return request(`/projects/${projectId}/conversations/${conversationId}/model`, {
    method: "PUT",
    body: JSON.stringify(model),
  });
}

export async function startPreview(projectId: string): Promise<{ url: string }> {
  return request(`/projects/${projectId}/preview`, { method: "POST" });
}

export async function sendPrompt(
  projectId: string,
  conversationId: string,
  prompt: string,
  references: PromptReference[] = [],
): Promise<PromptResponse> {
  return request(`/projects/${projectId}/conversations/${conversationId}/turns`, {
    method: "POST",
    body: JSON.stringify({ prompt, ...(references.length ? { references } : {}) }),
  });
}

export async function removePendingPrompt(projectId: string, conversationId: string, turnId: string): Promise<void> {
  await request(`/projects/${projectId}/conversations/${conversationId}/pending-prompt`, {
    method: "DELETE",
    body: JSON.stringify({ turnId }),
  });
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

function apiUrl(path: string): string {
  const runtime = desktopRuntime();
  return runtime ? `${runtime.daemonUrl}${path}` : `${API_BASE}${path}`;
}

function runtimeHeaders(): HeadersInit {
  const runtime = desktopRuntime();
  return runtime ? { authorization: `Bearer ${runtime.token}` } : {};
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
