import { createAiCutout } from "./ai-cutout.js";
import { isCanvasTable, type CanvasTableDetail } from "../shared/canvas-table.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasMarkdownDocument } from "../shared/canvas-document.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";
import { isCanvasBoard, type CanvasBoard } from "../shared/canvas-workspace.js";
import { CanvasError, CanvasStore } from "./canvas-workspace.js";
import type { ProjectManager } from "./projects.js";
import type { AssetLibrary } from "./asset-library.js";
import { ToolRunError, type ToolRunner } from "./tools.js";
import { brushRetouchImage, composeGif, composeImageLayers, composeVideo, cropImage, cutoutImage, extractGifFrames, extractVideoFrames, extractVideoStrip, outlineImage, removeBlueScreen, removeGreenScreen, removeWhiteBackground, resizeImage, sortFrames, splitImageGrid, stitchImages, type ImageLayer } from "./media-tools.js";
import type { CanvasMediaOperation } from "../shared/media-tools.js";
import { ensureCanvasAssets, readCanvasAssets } from "./canvas-assets.js";
import { getWorkspaceMedia } from "./workspace.js";

export function registerCanvasRoutes(app: FastifyInstance, options: {
  projects: ProjectManager; library: AssetLibrary; tools: ToolRunner; mediaModelDirectory: string;
}): CanvasStore {
  const aiCutout = createAiCutout(options.mediaModelDirectory);
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
  app.post<{ Params: { projectId: string }; Body: CanvasMediaRequest }>(`${base}/media`, {
    bodyLimit: 64 * 1024,
  }, async (request, reply) => {
    try { return reply.code(200).send(await runCanvasMedia({ ...options, aiCutout }, request.params.projectId, request.body)); } catch (cause) { return failure(cause, reply); }
  });
  app.get<{ Params: { projectId: string } }>(`${base}/jobs`, async (request, reply) => {
    try { return await store.jobs(request.params.projectId); } catch (cause) { return failure(cause, reply); }
  });
  for (const action of ["cancel", "retry"] as const) app.post<{ Params: { projectId: string; jobId: string } }>(`${base}/jobs/:jobId/${action}`, async (request, reply) => {
    try { return await store[action](request.params.projectId, request.params.jobId); } catch (cause) { return failure(cause, reply); }
  });
  return store;
}

interface CanvasMediaRequest {
  operation: CanvasMediaOperation;
  assetIds: string[];
  options?: {
    width?: number;
    height?: number;
    columns?: number;
    rows?: number;
    selectedFrames?: number[];
    layers?: ImageLayer[];
    fps?: number;
    startTime?: number;
    duration?: number;
    tolerance?: number;
    thickness?: number;
    color?: string;
    left?: number;
    top?: number;
    points?: Array<{ x: number; y: number }>;
    strength?: number;
    strokes?: Array<Array<{ x: number; y: number }>>;
    radius?: number;
    direction?: "horizontal" | "vertical";
    format?: "png" | "jpg" | "jpeg" | "webp" | "mp4" | "gif";
  };
}

type CanvasMediaResult =
  | { kind: "asset"; assetId: string; name: string; mediaType: string }
  | { kind: "assets"; assets: Array<{ assetId: string; name: string; mediaType: string }> }
  | { kind: "download"; path: string; name: string; mediaType: string; frameCount?: number };

async function runCanvasMedia(
  options: { projects: ProjectManager; library: AssetLibrary; aiCutout: ReturnType<typeof createAiCutout> },
  projectId: string,
  request: CanvasMediaRequest,
): Promise<CanvasMediaResult> {
  const project = options.projects.get(projectId);
  if (!project) throw new CanvasError("Project not found", 404);
  if (!Array.isArray(request.assetIds) || request.assetIds.length < 1 || request.assetIds.length > 1_000 || request.assetIds.some((id) => typeof id !== "string" || !id)) {
    throw new CanvasError("Choose at least one canvas asset", 400);
  }
  // A node can be acted on immediately after it is added, before the board
  // save that normally registers its library asset in canvas/assets.json.
  // Materialize any missing library assets here so the operation does not
  // fail silently because the save request is still in flight.
  let manifest = await readCanvasAssets(project.workspacePath);
  const missingAssetIds = request.assetIds.filter((id) => !manifest.assets[id]);
  if (missingAssetIds.length) {
    await ensureCanvasAssets(project, options.projects, options.library, missingAssetIds);
    manifest = await readCanvasAssets(project.workspacePath);
  }
  const sources = await Promise.all(request.assetIds.map(async (id) => {
    const asset = manifest.assets[id];
    if (!asset) throw new CanvasError(`Canvas asset not found: ${id}`, 404);
    return getWorkspaceMedia(project.workspacePath, asset.path);
  }));
  const input = request.options ?? {};
  const first = sources[0]!;
  let output: { name: string; bytes: Buffer; mediaType: string } | undefined;
  let outputs: Awaited<ReturnType<typeof splitImageGrid>> | undefined;
  if (request.operation === "ai-cutout") {
    requireMedia(first.contentType, "image");
    output = await options.aiCutout(first.absolutePath);
  } else if (request.operation === "split-image-grid") {
    requireMedia(first.contentType, "image");
    const columns = input.columns ?? 2;
    const rows = input.rows ?? 2;
    const cellCount = columns * rows;
    if (!validInteger(columns, 1, 100) || !validInteger(rows, 1, 100) || cellCount > 1_000) throw new CanvasError("Invalid grid size", 400);
    if (input.selectedFrames !== undefined && (!Array.isArray(input.selectedFrames) || !input.selectedFrames.length || input.selectedFrames.some((index, position) => !validInteger(index, 0, cellCount - 1) || (position > 0 && index <= input.selectedFrames![position - 1]!)))) throw new CanvasError("Invalid selected frames", 400);
    outputs = await splitImageGrid({ inputPath: first.absolutePath, columns: input.columns ?? 2, rows: input.rows ?? 2, selectedFrames: input.selectedFrames, format: input.format === "jpeg" ? "jpeg" : input.format === "webp" ? "webp" : "png" });
  } else if (request.operation === "compose-image-layers") {
    if (sources.some((source) => !source.contentType.startsWith("image/"))) throw new CanvasError("Layer composition requires image assets", 400);
    if (!Array.isArray(input.layers) || input.layers.length !== sources.length || input.layers.length > 100 || input.layers.some((layer) => !layer || !validInteger(layer.x, -16_384, 16_384) || !validInteger(layer.y, -16_384, 16_384) || !validRange(layer.scale, 0.05, 8) || !validRange(layer.opacity, 0, 1) || typeof layer.visible !== "boolean") || !validInteger(input.width, 1, 16_384) || !validInteger(input.height, 1, 16_384) || input.width * input.height > 100_000_000) throw new CanvasError("Invalid layer settings or canvas dimensions", 400);
    output = await composeImageLayers({ inputPaths: sources.map((source) => source.absolutePath), layers: input.layers, width: input.width, height: input.height });
  } else if (request.operation === "extract-video-frames") {
    requireMedia(first.contentType, "video");
    outputs = await extractVideoFrames({ inputPath: first.absolutePath, fps: input.fps, startTime: input.startTime, duration: input.duration, format: input.format === "jpg" ? "jpg" : "png" });
  } else if (request.operation === "video-frame-strip") {
    requireMedia(first.contentType, "video");
    if (input.selectedFrames !== undefined && (!Array.isArray(input.selectedFrames) || !input.selectedFrames.length || input.selectedFrames.some((index, position) => !validInteger(index, 0, 999) || (position > 0 && index <= input.selectedFrames![position - 1]!)))) throw new CanvasError("Invalid selected video frames", 400);
    outputs = await extractVideoStrip({ inputPath: first.absolutePath, fps: input.fps, startTime: input.startTime, duration: input.duration, selectedFrames: input.selectedFrames, format: input.format === "jpg" ? "jpg" : "png" });
  } else if (request.operation === "compose-video") {
    if (sources.some((source) => !source.contentType.startsWith("image/"))) throw new CanvasError("Video composition requires image frame assets", 400);
    output = await composeVideo({ framePaths: sources.map((source) => source.absolutePath), fps: input.fps, format: input.format === "gif" ? "gif" : "mp4" });
  } else if (request.operation === "remove-green-screen" || request.operation === "remove-blue-screen" || request.operation === "remove-white-background" || request.operation === "resize-image" || request.operation === "outline-image" || request.operation === "crop-image" || request.operation === "cutout-image" || request.operation === "brush-retouch-image" || request.operation === "extract-gif-frames") {
    requireMedia(first.contentType, "image");
    const imageInput = { inputPath: first.absolutePath, format: input.format === "jpg" ? "jpeg" as const : input.format as "png" | "jpeg" | "webp" | undefined };
    if (request.operation === "remove-green-screen") output = await removeGreenScreen({ ...imageInput, tolerance: input.tolerance });
    else if (request.operation === "remove-blue-screen") output = await removeBlueScreen({ ...imageInput, tolerance: input.tolerance });
    else if (request.operation === "remove-white-background") output = await removeWhiteBackground({ ...imageInput, tolerance: input.tolerance });
    else if (request.operation === "resize-image") {
      if (input.width === undefined) throw new CanvasError("Resize width is required", 400);
      output = await resizeImage({ ...imageInput, width: input.width, height: input.height });
    }
    else if (request.operation === "outline-image") output = await outlineImage({ ...imageInput, thickness: input.thickness ?? 1, color: input.color });
    else if (request.operation === "crop-image") {
      if (input.width === undefined || input.height === undefined) throw new CanvasError("Crop width and height are required", 400);
      output = await cropImage({ ...imageInput, left: input.left ?? 0, top: input.top ?? 0, width: input.width, height: input.height });
    }
    else if (request.operation === "cutout-image") output = await cutoutImage({ ...imageInput, points: input.points ?? [] });
    else if (request.operation === "brush-retouch-image") output = await brushRetouchImage({ ...imageInput, strokes: input.strokes ?? [], radius: input.radius ?? 48, strength: input.strength });
    else {
      if (first.contentType !== "image/gif") throw new CanvasError("GIF extraction requires a GIF asset", 400);
      outputs = await extractGifFrames({ inputPath: first.absolutePath });
    }
  } else if (request.operation === "compose-gif") {
    if (sources.some((source) => !source.contentType.startsWith("image/"))) throw new CanvasError("GIF composition requires image frame assets", 400);
    output = await composeGif(sources.map((source) => source.absolutePath), input.fps);
  } else if (request.operation === "sort-frames") {
    if (sources.some((source) => !source.contentType.startsWith("image/"))) throw new CanvasError("Frame sorting requires image assets", 400);
    outputs = await sortFrames(sources.map((source) => source.absolutePath));
  } else if (request.operation === "stitch-images") {
    if (sources.some((source) => !source.contentType.startsWith("image/"))) throw new CanvasError("Image stitching requires image assets", 400);
    output = await stitchImages({ inputPaths: sources.map((source) => source.absolutePath), direction: input.direction });
  } else {
    throw new CanvasError("Unsupported media operation", 400);
  }
  if (outputs) {
    const frameOutputs = outputs.filter((item) => item.mediaType.startsWith("image/") || item.mediaType.startsWith("video/"));
    if (!frameOutputs.length) throw new CanvasError("Media operation produced no frame assets", 500);
    const assets = await Promise.all(frameOutputs.map((frame) => options.library.add(frame.name, frame.bytes, {
      origin: "generated",
      sourceKey: `canvas-media:${projectId}:${randomUUID()}`,
    })));
    await ensureCanvasAssets(project, options.projects, options.library, assets.map((asset) => asset.id));
    return {
      kind: "assets",
      assets: assets.map((asset) => ({
        assetId: asset.id,
        name: asset.name,
        mediaType: asset.mediaType,
      })),
    };
  }
  if (!output) throw new CanvasError("Media operation produced no output", 500);
  const asset = await options.library.add(output.name, output.bytes, { origin: "generated", sourceKey: `canvas-media:${projectId}:${randomUUID()}` });
  await ensureCanvasAssets(project, options.projects, options.library, [asset.id]);
  return { kind: "asset", assetId: asset.id, name: asset.name, mediaType: asset.mediaType };
}

function requireMedia(contentType: string, expected: "image" | "video"): void {
  if (!contentType.startsWith(`${expected}/`)) throw new CanvasError(`This operation requires a ${expected}`, 400);
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
