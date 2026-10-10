import { isCanvasTable, type CanvasTableDetail } from "../shared/canvas-table.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasMarkdownDocument } from "../shared/canvas-document.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";
import { isCanvasBoard, type CanvasBoard } from "../shared/canvas-workspace.js";
import { CanvasError, CanvasStore } from "./canvas-workspace.js";
import type { ProjectManager } from "./projects.js";
import type { AssetLibrary } from "./asset-library.js";
import { ToolRunError, type ToolRunner } from "./tools.js";

export function registerCanvasRoutes(app: FastifyInstance, options: {
  projects: ProjectManager; library: AssetLibrary; tools: ToolRunner;
}): CanvasStore {
  const store = new CanvasStore(options.projects, options.library, options.tools);
  const failure = (cause: unknown, reply: FastifyReply) => reply.code(cause instanceof CanvasError || cause instanceof ToolRunError ? cause.statusCode : 500).send({ error: cause instanceof Error ? cause.message : String(cause) });
  const base = "/projects/:projectId/canvas";
  const documentId = (query: unknown): string | undefined => {
    const value = (query as { documentId?: unknown })?.documentId;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new CanvasError("Invalid document ID");
    return value;
  };
  app.get<{ Params: { projectId: string } }>(`${base}/workspace`, async (request, reply) => {
    try { return await store.workspace(request.params.projectId); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string; assetId: string } }>(`${base}/assets/:assetId/library`, async (request, reply) => {
    try { return await store.exportAsset(request.params.projectId, request.params.assetId); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string }; Body: { title: string } }>(`${base}/documents`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 200 } } } },
  }, async (request, reply) => {
    try { return reply.code(201).send(await store.createDocument(request.params.projectId, request.body.title)); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string }; Body: { title: string } }>(`${base}/tables`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 200 } } } },
  }, async (request, reply) => {
    try { return reply.code(201).send(await store.createTable(request.params.projectId, request.body.title)); } catch (cause) { return failure(cause, reply); }
  });
  app.get<{ Params: { projectId: string; tableId: string } }>(`${base}/tables/:tableId`, async (request, reply) => {
    try { return await store.table(request.params.projectId, request.params.tableId); } catch (cause) { return failure(cause, reply); }
  });
  app.put<{ Params: { projectId: string; tableId: string }; Body: CanvasTableDetail }>(`${base}/tables/:tableId`, { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    if (!isCanvasTable(request.body?.table) || request.body.table.id !== request.params.tableId || typeof request.body.revision !== "string") return reply.code(400).send({ error: "Invalid canvas table update" });
    try { return await store.saveTable(request.params.projectId, request.body.table, request.body.revision); } catch (cause) { return failure(cause, reply); }
  });
  app.put<{ Params: { projectId: string }; Body: { documentId: string } }>(`${base}/main-document`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["documentId"], properties: { documentId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" } } } },
  }, async (request, reply) => {
    try { await store.setMainDocument(request.params.projectId, request.body.documentId); return reply.code(204).send(); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string }; Body: { name: string } }>(`${base}/boards`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 120 } } } },
  }, async (request, reply) => {
    try { return reply.code(201).send(await store.changeBoards(request.params.projectId, { type: "create", name: request.body.name })); } catch (cause) { return failure(cause, reply); }
  });
  const boardRoute = `${base}/boards/:boardId`;
  app.get<{ Params: { projectId: string; boardId: string } }>(boardRoute, async (request, reply) => {
    try { return await store.board(request.params.projectId, request.params.boardId); } catch (cause) { return failure(cause, reply); }
  });
  app.put<{ Params: { projectId: string; boardId: string }; Body: { board: CanvasBoard; revision: string } }>(boardRoute, { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    if (!isCanvasBoard(request.body?.board) || request.body.board.id !== request.params.boardId || typeof request.body.revision !== "string") return reply.code(400).send({ error: "Invalid canvas board update" });
    try { return await store.saveBoard(request.params.projectId, request.body.board, request.body.revision); } catch (cause) { return failure(cause, reply); }
  });
  app.patch<{ Params: { projectId: string; boardId: string }; Body: { name?: string; direction?: number } }>(boardRoute, {
    schema: { body: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 120 }, direction: { enum: [-1, 1] } }, oneOf: [{ required: ["name"] }, { required: ["direction"] }] } },
  }, async (request, reply) => {
    try { return await store.changeBoards(request.params.projectId, { type: request.body.name !== undefined ? "rename" : "move", boardId: request.params.boardId, ...request.body }); } catch (cause) { return failure(cause, reply); }
  });
  app.delete<{ Params: { projectId: string; boardId: string } }>(boardRoute, async (request, reply) => {
    try { return await store.changeBoards(request.params.projectId, { type: "delete", boardId: request.params.boardId }); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string; boardId: string; nodeId: string } }>(`${boardRoute}/nodes/:nodeId/generate`, async (request, reply) => {
    try { return reply.code(202).send(await store.generateNode(request.params.projectId, request.params.boardId, request.params.nodeId)); } catch (cause) { return failure(cause, reply); }
  });
  app.get<{ Params: { projectId: string } }>(base, async (request, reply) => {
    try { return await store.read(request.params.projectId, documentId(request.query)) ?? null; } catch (cause) { return failure(cause, reply); }
  });
  app.put<{ Params: { projectId: string }; Body: { document: CanvasMarkdownDocument; revision: string } }>(base, { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const input = request.body;
    if (!input || !isCanvasDocument(input.document) || typeof input.revision !== "string") return reply.code(400).send({ error: "Invalid canvas document update" });
    try { return await store.save(request.params.projectId, input.document, input.revision, documentId(request.query)); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string; documentId: string }; Body: { assetId: string } }>(`${base}/documents/:documentId/images`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["assetId"], properties: { assetId: { type: "string", minLength: 1, maxLength: 120 } } } },
  }, async (request, reply) => {
    try { return await store.insertAsset(request.params.projectId, request.params.documentId, request.body.assetId); } catch (cause) { return failure(cause, reply); }
  });
  app.get<{ Params: { projectId: string } }>(`${base}/jobs`, async (request, reply) => {
    try { return await store.jobs(request.params.projectId); } catch (cause) { return failure(cause, reply); }
  });
  for (const action of ["cancel", "retry"] as const) app.post<{ Params: { projectId: string; jobId: string } }>(`${base}/jobs/:jobId/${action}`, async (request, reply) => {
    try { return await store[action](request.params.projectId, request.params.jobId); } catch (cause) { return failure(cause, reply); }
  });
  return store;
}
