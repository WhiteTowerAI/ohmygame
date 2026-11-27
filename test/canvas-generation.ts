import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { createAssetGenerationNode, type AssetCanvasStarter } from "../src/shared/asset-canvas.js";
import type { CanvasBoardDetail, CanvasWorkspaceDetail } from "../src/shared/canvas-workspace.js";
import type { AssetCanvasNode, AssetCanvasReference, ToolJob } from "../src/shared/contracts.js";

type NodeData<T extends AssetCanvasStarter> = Partial<Extract<AssetCanvasNode, { type: T }>["data"]>;

export interface CanvasGeneration {
  /** The generate request's response: 202 with the job, or the error the board or canvas refused it with. */
  response: LightMyRequestResponse;
  projectId: string;
  nodeId: string;
  /** Waits for the job to leave `running` and returns it with the node's output asset. */
  finished(timeout?: number): Promise<ToolJob & { assetId?: string }>;
}

/**
 * Generates once on a canvas node, the way a person or the Agent does: adds a
 * node with `data` to a project's board and asks the canvas to generate it.
 */
export async function generateOnCanvas<T extends AssetCanvasStarter>(
  app: FastifyInstance,
  type: T,
  data: NodeData<T>,
  options: { projectId?: string; headers?: Record<string, string> } = {},
): Promise<CanvasGeneration> {
  const headers = options.headers ?? {};
  const projectId = options.projectId
    ?? (await app.inject({ method: "POST", url: "/projects", headers, payload: { name: "Generation", type: "asset-canvas" } })).json<{ id: string }>().id;
  const base = `/projects/${projectId}/canvas`;
  const workspace = (await app.inject({ method: "GET", url: `${base}/workspace`, headers })).json<CanvasWorkspaceDetail>();
  const boardUrl = `${base}/boards/${workspace.boards[0]!.id}`;
  const board = (await app.inject({ method: "GET", url: boardUrl, headers })).json<CanvasBoardDetail>();
  const node = createAssetGenerationNode(type, { x: 0, y: 0 });
  Object.assign(node.data, data);
  board.board.nodes.push(node);
  board.board.editorLayout.nodes[node.id] = node.position;
  const saved = await app.inject({ method: "PUT", url: boardUrl, headers, payload: board });
  // A node the board refuses to save never generates; its response is the refusal.
  const response = saved.statusCode === 200
    ? await app.inject({ method: "POST", url: `${boardUrl}/nodes/${node.id}/generate`, headers })
    : saved;
  return {
    response,
    projectId,
    nodeId: node.id,
    async finished(timeout = 10_000) {
      expect(response.statusCode, response.body).toBe(202);
      const id = response.json<ToolJob>().id;
      let job: ToolJob | undefined;
      await expect.poll(async () => {
        job = (await app.inject({ method: "GET", url: `${base}/jobs`, headers })).json<ToolJob[]>().find((item) => item.id === id);
        return job?.status;
      }, { timeout }).not.toBe("running");
      const current = (await app.inject({ method: "GET", url: boardUrl, headers })).json<CanvasBoardDetail>()
        .board.nodes.find((item) => item.id === node.id);
      const assetId = current && "assetId" in current.data ? current.data.assetId : undefined;
      return { ...job!, ...(assetId ? { assetId } : {}) };
    },
  };
}

/** A 1×1 PNG, for nodes that only need some reference image. */
export const TINY_PNG = { mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } as const;

/** Adds an image to the Library as a reference a canvas node can use. */
export async function libraryReference(app: FastifyInstance, image: { mediaType: string; data: string } = TINY_PNG, headers: Record<string, string> = {}): Promise<AssetCanvasReference> {
  const uploaded = await app.inject({ method: "POST", url: "/library/assets", headers, payload: { name: "reference", purpose: "reference", image } });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  return { type: "library", assetId: uploaded.json<{ id: string }>().id };
}
