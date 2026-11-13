import type { AssetCanvasNode, AssetCanvasReference, ImageModelRef } from "./contracts.js";

// compat: since beta.5.7, remove from beta.7 and 2026-12-13. PixelLab's three
// generation canvas nodes moved to the standard Image node when it became a
// media-provider plugin. Read saved boards, drafts, the clipboard and presets
// with their completed output and image references intact, then save the new
// node shape.
const PROVIDER = "plugin.ohmygame.pixellab.pixellab";
const MODELS: Readonly<Record<string, ImageModelRef["id"]>> = {
  pixen: "pixen",
  "create-character": "create-character",
  "skeleton-animation": "skeleton-animation",
};

type LegacyData = {
  node?: unknown;
  params?: unknown;
  inputs?: unknown;
  assetId?: unknown;
};
type LegacyNode = Omit<AssetCanvasNode, "type" | "data"> & { type: "plugin"; data: LegacyData };

function legacy(node: unknown): node is LegacyNode {
  if (!node || typeof node !== "object") return false;
  const value = node as { type?: unknown; data?: LegacyData };
  return value.type === "plugin" && typeof value.data?.node === "string" && Object.hasOwn(MODELS, value.data.node.replace(/^ohmygame\/pixellab:/, ""));
}

function migratedNode(node: LegacyNode): AssetCanvasNode {
  const id = String(node.data.node).replace(/^ohmygame\/pixellab:/, "");
  const params = node.data.params && typeof node.data.params === "object" ? node.data.params as Record<string, unknown> : {};
  const inputs = node.data.inputs && typeof node.data.inputs === "object" ? node.data.inputs as Record<string, unknown> : {};
  const references = Array.isArray(inputs.reference) ? inputs.reference as AssetCanvasReference[] : [];
  const prompt = typeof (id === "skeleton-animation" ? params.action : params.description) === "string"
    ? String(id === "skeleton-animation" ? params.action : params.description)
    : "";
  return {
    ...node,
    type: "image",
    data: {
      prompt,
      model: { provider: PROVIDER, id: MODELS[id]! },
      resolution: "512",
      aspectRatio: "1:1",
      images: references,
      ...(typeof node.data.assetId === "string" ? { assetId: node.data.assetId } : {}),
    },
  };
}

/** Converts the retired PixelLab generation nodes into their Image-node successors. */
export function migrateLegacyPixelLabNodes<T>(value: T): { value: T; migrated: string[] } {
  const nodes = value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes) || !nodes.some(legacy)) return { value, migrated: [] };
  const migrated: string[] = [];
  return {
    value: { ...value as object, nodes: nodes.map((node) => {
      if (!legacy(node)) return node;
      migrated.push(String(node.id));
      return migratedNode(node);
    }) } as T,
    migrated,
  };
}
