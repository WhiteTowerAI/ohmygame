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
import { canvasNodeContent, canvasNodeLayout, contentNodeSizeIssue, isResizableCanvasNodeType, withoutContentNodeSize } from "./canvas-node-layout.js";
import { ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA, ASSET_CANVAS_SCHEMA } from "./asset-canvas-schema.js";
import { withPixelArtLevel, type PixelArtLevel } from "./canvas-pixel-style.js";

export type AssetCanvasStarter = "image" | "video" | "model-3d" | "music" | "audio-scene";

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
  videoReferenceMode?: "frame" | "reference";
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
      ...(options.videoReferenceMode ? { referenceMode: options.videoReferenceMode } : {}),
    },
  };
  if (type === "music") return { id, type, position, data: { prompt: "", instrumental: true } };
  if (type === "audio-scene") return { id, type, position, data: { prompt: "" } };
  return { id, type, position, data: { ...DEFAULT_MODEL_3D_CONFIG, images: [] } };
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
    throw new Error("Editor layout Node IDs must exactly match board Nodes");
  }
  for (const node of document.nodes) {
    const layout = document.editorLayout.nodes[node.id]!;
    if (!isResizableCanvasNodeType(node.type) && [node.width, node.height, layout.width, layout.height].some((value) => value !== undefined)) {
      throw new Error(contentNodeSizeIssue(node));
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of document.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate Asset Canvas edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error(`Asset Canvas edge ${edge.id} references a missing Node`);
  }
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  for (const node of document.nodes) {
    const seen = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId) {
      const parent = nodes.get(parentId);
      if (parent?.type !== "group" || seen.has(parentId)) throw new Error(`Node ${node.id} has an invalid parent group`);
      seen.add(parentId);
      parentId = parent.parentId;
    }
    if (node.type === "group" && (!node.width || !node.height)) throw new Error(`Group ${node.id} needs a width and height`);
  }
  for (const node of document.nodes) {
    if (node.type === "text" || node.type === "document") {
      for (const reference of node.data.references ?? []) {
        const source = nodes.get(reference.nodeId);
        if (!source || source.id === node.id || !isTextGenerationReferenceNode(source) ||
          (node.type === "document" && source.type === "document" && source.data.documentId === node.data.documentId)) {
          throw new Error(`Node ${node.id} has an invalid generation reference`);
        }
      }
    }
    if (node.type === "image" || node.type === "model-3d") {
      for (const reference of node.data.images) validateReference(node.id, reference, nodes, ["image", "asset"]);
    }
    if (node.type === "video") {
      for (const reference of node.data.references) validateReference(node.id, reference, nodes, ["image", "video", "asset"]);
    }
    if (node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene") {
      const references = node.data.audioReferences ?? [];
      if (new Set(references.map((reference) => reference.id)).size !== references.length) throw new Error(`Node ${node.id} has duplicate audio reference aliases`);
      for (const reference of references) {
        validateReference(node.id, reference.source, nodes, reference.type === "image" ? ["image", "asset"] : ["speech", "sound-effect", "music", "audio-scene", "asset"]);
        if (reference.source.type === "node") {
          const source = nodes.get(reference.source.nodeId);
          if (source?.type === "asset" && source.data.mediaType !== reference.type) throw new Error(`Node ${node.id} has a reference with the wrong media type`);
        }
      }
    }
    if ((node.type === "animate-3d" || node.type === "model-3d") && node.data.source) validateReference(node.id, node.data.source, nodes, ["model-3d", "animate-3d", "asset"]);
    if ((node.type === "image" || node.type === "video" || node.type === "model-3d" || node.type === "speech" || node.type === "sound-effect" || node.type === "music" || node.type === "audio-scene") && node.data.promptSource) {
      const source = nodes.get(node.data.promptSource.nodeId);
      if (!source || (source.type !== "text" && source.type !== "document") || source.id === node.id) throw new Error(`Node ${node.id} has an invalid Text reference`);
    }
  }
}

export function isTextGenerationReferenceNode(node: { type?: AssetCanvasNode["type"]; data: object }): boolean {
  return node.type === "text" || node.type === "document" || node.type === "image" || (node.type === "asset" && "mediaType" in node.data && node.data.mediaType === "image");
}

/** Applies {@link withoutContentNodeSize} to unsaved or copied canvas data created before sizes were validated. */
export function withoutContentNodeSizes(document: AssetCanvasDocument): AssetCanvasDocument {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const layout: AssetCanvasDocument["editorLayout"]["nodes"] = Object.create(null);
  for (const [id, position] of Object.entries(document.editorLayout.nodes)) {
    const node = nodes.get(id);
    layout[id] = node && !isResizableCanvasNodeType(node.type) ? { x: position.x, y: position.y } : position;
  }
  return { ...document, nodes: document.nodes.map(withoutContentNodeSize), editorLayout: { ...document.editorLayout, nodes: layout } };
}

export function isAssetCanvasDocument(value: unknown): value is AssetCanvasDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as AssetCanvasDocument;
  try {
    const { editorLayout, ...rest } = document;
    const persisted = { ...rest, nodes: rest.nodes.map(canvasNodeContent) };
    if (!Check(ASSET_CANVAS_SCHEMA, persisted) || !Check(ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA, editorLayout)) return false;
    if (!document.nodes.every((node) => Check(ASSET_CANVAS_EDITOR_LAYOUT_SCHEMA.properties.nodes.additionalProperties, canvasNodeLayout(node)))) return false;
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
  if (source.type === "asset" && allowed.includes("model-3d") && source.data.mediaType !== "model") throw new Error(`Node ${ownerId} requires a model reference`);
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
  return node && "assetId" in node.data ? node.data.assetId : undefined;
}

export function combineAssetCanvasPrompt(linkedText: string | undefined, localPrompt: string): string {
  return [linkedText, localPrompt].map((part) => part?.trim()).filter(Boolean).join("\n\n");
}

/** Safety constraint for generated sprite sheets so grid splitting cannot clip a frame. */
export const EFFECT_SPRITE_SHEET_SAFE_MARGIN_PROMPT = "The final output must be a PNG with a real transparent alpha channel. Do not render any background plane, gradient, glow field, checkerboard, black, white, green, gray, blue, or other background color; pixels outside the effects must be fully transparent. If transparent output is unsupported, do not fake it with a colored background. Treat every cell as an independent square canvas. Keep every frame fully inside its own cell with a clear transparent margin on all four sides, including the ground contact or baseline. Coarse and classic effects stay within about 60% of the cell; detailed effects may occupy about 75–85% while preserving the margin. No visual element, baseline, particle, glow, or shadow may touch, cross, or be clipped by the cell boundaries. Keep identical scale, baseline, camera framing, and ground point in every frame. Keep the full effect visible from top to bottom in every frame.";

/** Default editor template for image nodes created inside the Effect Library. */
export const EFFECT_LIBRARY_DEFAULT_PROMPT_TEMPLATE = "Requested action: {USER_ACTION}\n\nMain color: {EFFECT_COLOR}\n\nMotion rhythm: {MOTION_RHYTHM}\n\nAdditional direction:\n{ADDITIONAL_PROMPT}";

const EFFECT_DETAILED_PIXEL_RULES = "DETAILED EFFECT PIXEL RULES: Render at premium 32-bit pixel-art illustration fidelity using the full 256×256 logical pixel budget per frame, never enlarged classic-pixel shapes. At 2048 output, preserve clearly visible 2×2 or larger pixel clusters; at 1024 output, preserve the full detailed design rather than simplifying it to classic density. The effect should occupy roughly 75–85% of each cell while retaining a clear transparent margin; do not shrink it into a small icon. Preserve secondary contour breaks, layered highlights, compact particle clusters, internal material structure, and controlled texture in every phase. Make the bright core, lit plane, saturated midtone body, dark occlusion rim, thin rim light, reflected light, subsurface/translucent bands, and transient fragments visibly distinct with 6–8 hard-edged palette steps. Build material-specific volume: faceted internal refraction and cold glints for ice, layered translucent depth and sharp surface reflections for water, granular ember texture and hot-to-cool falloff for fire, and nested emissive cores with stepped radiating bands for magic or electricity. Retain thin readable arcs, tendrils, droplets, sparks, shards, and smoke fragments where they clarify motion; build each from connected multi-pixel clusters with varied sizes rather than isolated dots. Do not replace material structure with smooth glows, anti-aliased edges, noise, or random speckles. Keep the silhouette, palette, scale, light direction, and frame-to-frame motion coherent.";

const EFFECT_SMOKE_MATERIAL_PROMPT = "SMOKE MATERIAL DIRECTION: Build smoke as thick, curling, layered vapor ribbons and overlapping lobes, not flat circles or soft clouds. Use a cool gray-blue palette with near-white lit ridges, slate midtones, and deep blue-gray occlusion pockets. Give each curl a readable rolled edge, hollow opening, tapered tail, and internal fold; vary lobe size and direction while keeping the main mass coherent. Animate a clear progression from a compact seed, through a dense twisting billow, to separated wisps and tiny fragments. Keep the volume fully hard-edged and pixel-clustered: no blur, airbrush, smooth gradient, random noise, or one-pixel confetti.";
const EFFECT_DETAILED_QUALITY_BAR = "DETAILED EFFECT QUALITY BAR: Match the fidelity of a professionally authored high-detail game VFX sprite sheet. Every substantial effect form must be built from many connected pixel clusters with nested contours, internal folds or facets, contact occlusion, reflected light, and small secondary fragments; never represent the form as a few oversized blobs. Distribute the detail across the entire silhouette and every animation phase, including buildup, peak, breakup, and fade. Preserve a clear material identity through stepped value grouping and controlled texture: rolled layered volume for smoke or clouds, faceted planes for ice or stone, translucent bands and sharp reflections for water, granular clustered breakup for fire or dust, and nested emissive bands for magic or electricity. Keep edges crisp and intentionally stair-stepped, with no blur, anti-aliasing, airbrush shading, smooth gradients, random noise, or flat vector-like fills. The result should remain richly readable when each cell is viewed alone at preview size and when enlarged with nearest-neighbor.";

/** Builds the complete, portable prompt behind an Effect Library image node. */
export function effectLibraryPrompt(
  basePrompt: string | undefined,
  color: "original" | "ice-blue" | "electric-purple" | "toxic-green" | "gold" | undefined,
  rhythm: "sample" | "quick" | "extended" | undefined,
  additionalPrompt: string,
  pixelStyle: PixelArtLevel = "classic",
): string {
  if (!basePrompt) return [additionalPrompt, EFFECT_SPRITE_SHEET_SAFE_MARGIN_PROMPT].map((part) => part.trim()).filter(Boolean).join("\n\n");
  const colorDirection = {
    original: "Color direction: preserve the effect's original palette consistently across every frame.",
    "ice-blue": "Color direction: use an icy cyan and deep-blue palette across every frame, with a near-white core. Do not use the original warm palette.",
    "electric-purple": "Color direction: use an electric violet and indigo palette across every frame, with a near-white core.",
    "toxic-green": "Color direction: use a luminous toxic-green and deep-teal palette across every frame, with a pale green core.",
    gold: "Color direction: use a radiant gold and amber palette across every frame, with a near-white core.",
  }[color ?? "original"];
  const rhythmDirection = {
    sample: "Timing direction: keep the sample rhythm: a balanced buildup, peak impact, and fade-out.",
    quick: "Timing direction: make the motion short and forceful: a very brief buildup, an immediate peak impact, then a fast fade-out.",
    extended: "Timing direction: make the motion spacious and extended: a gradual buildup, a longer peak hold, then a slow fade-out.",
  }[rhythm ?? "sample"];
  const gridMatch = basePrompt.match(/(\d+)-column by (\d+)-row Sprite Sheet/i);
  const columns = Number(gridMatch?.[1] ?? 4);
  const rows = Number(gridMatch?.[2] ?? 3);
  const densityPrompt = withPixelArtLevel("EFFECT PIXEL DENSITY RULES:", pixelStyle, "sprite", {
    assetType: "effect",
    grid: { columns, rows, unit: "frame" },
  });
  const smokePrompt = /smoke|烟雾|烟团/i.test(basePrompt) ? EFFECT_SMOKE_MATERIAL_PROMPT : "";
  return [colorDirection, rhythmDirection, densityPrompt, pixelStyle === "detailed" ? `${EFFECT_DETAILED_PIXEL_RULES}\n\n${EFFECT_DETAILED_QUALITY_BAR}` : "", smokePrompt, EFFECT_SPRITE_SHEET_SAFE_MARGIN_PROMPT, basePrompt, additionalPrompt]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}
