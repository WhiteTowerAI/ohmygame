import type {
  AssetCanvasDocument,
  AssetCanvasNode,
  AssetCanvasReference,
  ImageModel,
  ImageModelRef,
  VideoModelRef,
} from "./contracts.js";
import {
  DEFAULT_IMAGE_NODE_CONFIG,
  DEFAULT_MODEL_3D_CONFIG,
  DEFAULT_VIDEO_NODE_CONFIG,
} from "./generation-config.js";
import { Check } from "typebox/value";
import { ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA, ASSET_CANVAS_SCHEMA } from "./asset-canvas-schema.js";

export type AssetCanvasStarter = "image" | "video" | "model-3d";

export function createAssetCanvasDocument(): AssetCanvasDocument {
  return {
    version: 1,
    editorLayout: { version: 1, nodes: {}, viewport: { x: 64, y: 32, zoom: 1 }, view: "canvas" },
    viewport: { width: 1280, height: 720 },
    nodes: [],
    edges: [],
  };
}

export function createAssetGenerationNode(type: AssetCanvasStarter, position: { x: number; y: number }, options: {
  imageModel?: ImageModelRef;
  videoModel?: VideoModelRef;
  imageResolution?: Extract<AssetCanvasNode, { type: "image" }>["data"]["resolution"];
  imageAspectRatio?: Extract<AssetCanvasNode, { type: "image" }>["data"]["aspectRatio"];
  videoAspectRatio?: Extract<AssetCanvasNode, { type: "video" }>["data"]["aspectRatio"];
} = {}): Extract<AssetCanvasNode, { type: AssetCanvasStarter }> {
  const id = crypto.randomUUID();
  if (type === "image") return {
    id,
    type,
    position,
    data: {
      prompt: "",
      ...(options.imageModel ? { model: options.imageModel } : {}),
      resolution: options.imageResolution ?? DEFAULT_IMAGE_NODE_CONFIG.resolution,
      aspectRatio: options.imageAspectRatio ?? DEFAULT_IMAGE_NODE_CONFIG.aspectRatio,
      images: [],
    },
  };
  if (type === "video") return {
    id,
    type,
    position,
    data: {
      prompt: "",
      ...(options.videoModel ? { model: options.videoModel } : {}),
      resolution: DEFAULT_VIDEO_NODE_CONFIG.resolution,
      aspectRatio: options.videoAspectRatio ?? DEFAULT_VIDEO_NODE_CONFIG.aspectRatio,
      duration: DEFAULT_VIDEO_NODE_CONFIG.duration,
      references: [],
    },
  };
  return { id, type, position, data: { ...DEFAULT_MODEL_3D_CONFIG, images: [] } };
}

export function createAssetCanvasStarterDocument(
  type: AssetCanvasStarter,
  options: Parameters<typeof createAssetGenerationNode>[2] = {},
): { document: AssetCanvasDocument; nodeId: string } {
  const document = createAssetCanvasDocument();
  const node = createAssetGenerationNode(type, { x: 96, y: 96 }, options);
  document.nodes = [node];
  document.editorLayout.nodes = { [node.id]: node.position };
  return { document, nodeId: node.id };
}

export function preferredImageOption(model?: ImageModel, preferredAspectRatio = "1:1"): ImageModel["generationOptions"][number] | undefined {
  return model?.generationOptions.find((option) => option.resolution === "1K" && option.aspectRatio === preferredAspectRatio)
    ?? model?.generationOptions.find((option) => option.aspectRatio === preferredAspectRatio)
    ?? model?.generationOptions.find((option) => option.resolution === "1K" && option.aspectRatio === "1:1")
    ?? model?.generationOptions[0];
}

export function validateAssetCanvasDocument(document: AssetCanvasDocument): void {
  const nodeIds = new Set<string>();
  for (const node of document.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`Duplicate Asset Canvas Node ID: ${node.id}`);
    nodeIds.add(node.id);
  }
  const layoutIds = Object.keys(document.editorLayout.nodes);
  if (layoutIds.length !== nodeIds.size || layoutIds.some((id) => !nodeIds.has(id))) {
    throw new Error("editor/layout.json Node IDs must exactly match canvas.json Nodes");
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate Asset Canvas edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error(`Asset Canvas edge ${edge.id} references a missing Node`);
  }
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  for (const node of document.nodes) {
    if (node.type === "image" || node.type === "model-3d") {
      for (const reference of node.data.images) validateReference(node.id, reference, nodes, ["image", "asset"]);
    }
    if (node.type === "video") {
      for (const reference of node.data.references) validateReference(node.id, reference, nodes, ["image", "video", "asset"]);
    }
    if ((node.type === "image" || node.type === "video") && node.data.promptSource) {
      const source = nodes.get(node.data.promptSource.nodeId);
      if (source?.type !== "text" || source.id === node.id) throw new Error(`Node ${node.id} has an invalid Text reference`);
    }
  }
}

export function isAssetCanvasDocument(value: unknown): value is AssetCanvasDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as AssetCanvasDocument;
  try {
    const { editorLayout, ...rest } = document;
    const persisted = { ...rest, nodes: rest.nodes.map(({ position: _position, ...node }) => node) };
    if (!Check(ASSET_CANVAS_SCHEMA, persisted) || !Check(ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA, editorLayout)) return false;
    validateAssetCanvasDocument(document);
    return true;
  } catch {
    return false;
  }
}

function validateReference(
  ownerId: string,
  reference: AssetCanvasReference,
  nodes: ReadonlyMap<string, AssetCanvasNode>,
  allowed: readonly AssetCanvasNode["type"][],
): void {
  if (reference.type === "library") return;
  const source = nodes.get(reference.nodeId);
  if (!source || source.id === ownerId || !allowed.includes(source.type)) {
    throw new Error(`Node ${ownerId} has an invalid Node reference`);
  }
  if (source.type === "asset" && allowed.length === 2 && source.data.mediaType !== "image") {
    throw new Error(`Node ${ownerId} requires an image reference`);
  }
}

export function resolveAssetCanvasImageAssetId(nodes: readonly AssetCanvasNode[], reference: AssetCanvasReference): string | undefined {
  if (reference.type === "library") return reference.assetId;
  const node = nodes.find((candidate) => candidate.id === reference.nodeId);
  if (node?.type === "image") return node.data.assetId;
  return node?.type === "asset" && node.data.mediaType === "image" ? node.data.assetId : undefined;
}

export function resolveAssetCanvasAssetId(nodes: readonly AssetCanvasNode[], reference: AssetCanvasReference): string | undefined {
  if (reference.type === "library") return reference.assetId;
  const node = nodes.find((candidate) => candidate.id === reference.nodeId);
  return node?.type === "image" || node?.type === "video" || node?.type === "asset" ? node.data.assetId : undefined;
}

export function combineAssetCanvasPrompt(linkedText: string | undefined, localPrompt: string): string {
  return [linkedText, localPrompt].map((part) => part?.trim()).filter(Boolean).join("\n\n");
}
