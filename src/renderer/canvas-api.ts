import type { CanvasTableDetail, CanvasTableGenerationRequest, CanvasTableGenerationResponse } from "../shared/canvas-table.js";
import type { AgentModelRef, AgentReasoningLevel, AssetCanvasTextGenerationResponse, AssetCanvasTextGenerationSource, ToolJob } from "../shared/contracts.js";
import type { CanvasDocumentDetail, CanvasDocumentGenerationRequest, CanvasDocumentGenerationResponse } from "../shared/canvas-document.js";
import type { CanvasBoardDetail, CanvasWorkspaceDetail, CanvasWorkspaceIndex } from "../shared/canvas-workspace.js";
import { request } from "./api.js";
import type { WorkspaceRequestInit } from "./workspace-version.js";
import { t } from "./i18n.js";

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/canvas`;
const query = (documentId?: string) => documentId ? `?documentId=${encodeURIComponent(documentId)}` : "";
export const getCanvasWorkspace = (id: string): Promise<CanvasWorkspaceDetail> => canvasRequest(`${base(id)}/workspace`);
export const exportCanvasAsset = (id: string, assetId: string): Promise<{ assetId: string }> => canvasRequest(`${base(id)}/assets/${encodeURIComponent(assetId)}/library`, { method: "POST" });
export const setMainCanvasDocument = (id: string, documentId: string, version?: string): Promise<void> => canvasRequest(`${base(id)}/main-document`, { method: "PUT", body: JSON.stringify({ documentId }), workspaceVersion: version });
export const getCanvasBoard = (id: string, boardId: string): Promise<CanvasBoardDetail> => canvasRequest(`${base(id)}/boards/${encodeURIComponent(boardId)}`);
export const saveCanvasBoard = (id: string, detail: CanvasBoardDetail, version?: string): Promise<CanvasBoardDetail> => canvasRequest(`${base(id)}/boards/${encodeURIComponent(detail.board.id)}`, { method: "PUT", body: JSON.stringify(detail), workspaceVersion: version });
export const createCanvasBoard = (id: string, name: string, version?: string): Promise<CanvasWorkspaceIndex> => canvasRequest(`${base(id)}/boards`, { method: "POST", body: JSON.stringify({ name }), workspaceVersion: version });
export const changeCanvasBoard = (id: string, boardId: string, patch: { name?: string; direction?: number }, version?: string): Promise<CanvasWorkspaceIndex> => canvasRequest(`${base(id)}/boards/${encodeURIComponent(boardId)}`, { method: "PATCH", body: JSON.stringify(patch), workspaceVersion: version });
export const deleteCanvasBoard = (id: string, boardId: string, version?: string): Promise<CanvasWorkspaceIndex> => canvasRequest(`${base(id)}/boards/${encodeURIComponent(boardId)}`, { method: "DELETE", workspaceVersion: version });
export const createCanvasDocument = (id: string, title: string, version?: string): Promise<CanvasDocumentDetail> => canvasRequest(`${base(id)}/documents`, { method: "POST", body: JSON.stringify({ title }), workspaceVersion: version });
export const getCanvasDocument = (id: string, documentId?: string): Promise<CanvasDocumentDetail | null> => canvasRequest(`${base(id)}${query(documentId)}`);
export const saveCanvasDocument = (id: string, detail: CanvasDocumentDetail, documentId?: string, version?: string): Promise<CanvasDocumentDetail> => canvasRequest(`${base(id)}${query(documentId)}`, { method: "PUT", body: JSON.stringify(detail), workspaceVersion: version });
export const insertCanvasImage = (id: string, documentId: string, assetId: string, version?: string): Promise<CanvasDocumentDetail> => canvasRequest(`${base(id)}/documents/${encodeURIComponent(documentId)}/images`, { method: "POST", body: JSON.stringify({ assetId }), workspaceVersion: version });
export const listCanvasJobs = (id: string): Promise<ToolJob[]> => canvasRequest(`${base(id)}/jobs`);
export const generateCanvasMedia = (id: string, boardId: string, nodeId: string, version?: string): Promise<ToolJob> => request(`${base(id)}/boards/${encodeURIComponent(boardId)}/nodes/${encodeURIComponent(nodeId)}/generate`, { method: "POST", workspaceVersion: version });
export const cancelCanvasJob = (id: string, jobId: string): Promise<ToolJob> => canvasRequest(`${base(id)}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
export const generateCanvasText = (id: string, instruction: string, model: AgentModelRef, reasoningLevel?: AgentReasoningLevel, referenceSource?: AssetCanvasTextGenerationSource, version?: string): Promise<AssetCanvasTextGenerationResponse> => request(`${base(id)}/text/generate`, { method: "POST", body: JSON.stringify({ instruction, model, reasoningLevel, referenceSource }), workspaceVersion: version });
export const generateCanvasDocument = (id: string, documentId: string, input: CanvasDocumentGenerationRequest, version?: string): Promise<CanvasDocumentGenerationResponse> => request(`${base(id)}/documents/${encodeURIComponent(documentId)}/generate`, { method: "POST", body: JSON.stringify(input), workspaceVersion: version });

export const createCanvasTable = (id: string, title: string, version?: string): Promise<CanvasTableDetail> => canvasRequest(`${base(id)}/tables`, { method: "POST", body: JSON.stringify({ title }), workspaceVersion: version });
export const getCanvasTable = (id: string, tableId: string): Promise<CanvasTableDetail> => canvasRequest(`${base(id)}/tables/${encodeURIComponent(tableId)}`);
export const saveCanvasTable = (id: string, detail: CanvasTableDetail, version?: string): Promise<CanvasTableDetail> => canvasRequest(`${base(id)}/tables/${encodeURIComponent(detail.table.id)}`, { method: "PUT", body: JSON.stringify(detail), workspaceVersion: version });
export const generateCanvasTable = (id: string, tableId: string, input: CanvasTableGenerationRequest, version?: string): Promise<CanvasTableGenerationResponse> => request(`${base(id)}/tables/${encodeURIComponent(tableId)}/generate`, { method: "POST", body: JSON.stringify(input), workspaceVersion: version });

// Local canvas I/O should settle before the desktop close handshake expires.
async function canvasRequest<T>(path: string, init: WorkspaceRequestInit = {}): Promise<T> {
  const signal = AbortSignal.timeout(10_000);
  try { return await request<T>(path, { ...init, signal }); }
  catch (cause) {
    if (signal.aborted) throw new Error(t("canvas.timeout"));
    throw cause;
  }
}
