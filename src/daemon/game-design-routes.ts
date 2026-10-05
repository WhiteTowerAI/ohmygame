import type { FastifyInstance, FastifyReply } from "fastify";
import type { RunToolRequest, ToolId } from "../shared/contracts.js";
import type { GameDesignDocument } from "../shared/game-design.js";
import { isGameDesign } from "../shared/game-design-schema.js";
import { isDesignBoard, type DesignBoard } from "../shared/design-boards.js";
import { GameDesignError, GameDesignStore } from "./game-design.js";
import type { ProjectManager } from "./projects.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ToolRunner } from "./tools.js";

export function registerGameDesignRoutes(app: FastifyInstance, options: {
  projects: ProjectManager; library: AssetLibrary; tools: ToolRunner; toolInputSchema: object;
}): GameDesignStore {
  const store = new GameDesignStore(options.projects, options.library, options.tools);
  const failure = (cause: unknown, reply: FastifyReply) => reply.code(cause instanceof GameDesignError ? cause.statusCode : 500).send({ error: cause instanceof Error ? cause.message : String(cause) });
  const base = "/projects/:projectId/design";
  const documentId = (query: unknown): string | undefined => {
    const value = (query as { documentId?: unknown })?.documentId;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new GameDesignError("Invalid document ID");
    return value;
  };
  app.get<{ Params: { projectId: string } }>(`${base}/workspace`, async (request, reply) => {
    try { return await store.workspace(request.params.projectId); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string }; Body: { title: string } }>(`${base}/documents`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 200 } } } },
  }, async (request, reply) => {
    try { return reply.code(201).send(await store.createDocument(request.params.projectId, request.body.title)); } catch (cause) { return failure(cause, reply); }
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
  app.put<{ Params: { projectId: string; boardId: string }; Body: { board: DesignBoard; revision: string } }>(boardRoute, { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    if (!isDesignBoard(request.body?.board) || request.body.board.id !== request.params.boardId || typeof request.body.revision !== "string") return reply.code(400).send({ error: "Invalid design board update" });
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
  app.post<{ Params: { projectId: string; boardId: string; nodeId: string; toolId: ToolId }; Body: RunToolRequest }>(`${boardRoute}/nodes/:nodeId/generate/:toolId`, {
    schema: { body: options.toolInputSchema }, bodyLimit: 128 * 1024 * 1024,
  }, async (request, reply) => {
    try { return reply.code(202).send(await store.start(request.params.projectId, request.params.boardId, request.params.nodeId, request.params.toolId, request.body)); } catch (cause) { return failure(cause, reply); }
  });
  app.get<{ Params: { projectId: string } }>(base, async (request, reply) => {
    try { return { design: await store.read(request.params.projectId, documentId(request.query)) ?? null }; } catch (cause) { return failure(cause, reply); }
  });
  app.put<{ Params: { projectId: string }; Body: { document: GameDesignDocument; revision: string } }>(base, { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const input = request.body;
    if (!input || !isGameDesign(input.document) || typeof input.revision !== "string") return reply.code(400).send({ error: "Invalid design document update" });
    try { return await store.save(request.params.projectId, input.document, input.revision, documentId(request.query)); } catch (cause) { return failure(cause, reply); }
  });
  app.post<{ Params: { projectId: string; documentId: string }; Body: { assetId: string } }>(`${base}/documents/:documentId/images`, {
    schema: { body: { type: "object", additionalProperties: false, required: ["assetId"], properties: { assetId: { type: "string", minLength: 1, maxLength: 100 } } } },
  }, async (request, reply) => {
    try { return await store.insertAsset(request.params.projectId, request.params.documentId, request.body.assetId); } catch (cause) { return failure(cause, reply); }
  });
  app.get<{ Params: { projectId: string } }>(`${base}/jobs`, async (request, reply) => {
    try { return await store.jobs(request.params.projectId); } catch (cause) { return failure(cause, reply); }
  });
  for (const action of ["cancel", "retry"] as const) app.post<{ Params: { projectId: string; jobId: string } }>(`${base}/jobs/:jobId/${action}`, async (request, reply) => {
    try { return await store[action](request.params.projectId, request.params.jobId); } catch (cause) { return failure(cause, reply); }
  });
  app.addHook("onClose", () => store.close());
  return store;
}
