import type { ImageModel, ProjectState, VideoModel } from "../shared/contracts.js";
import { createAssetCanvasStarterDocument, preferredImageOption, type AssetCanvasStarter } from "../shared/asset-canvas.js";
import { createProject, deleteProject, listImageModels, listVideoModels, updateAssetCanvas } from "./api.js";

export interface AssetCanvasQuickStart {
  key: string;
  type: AssetCanvasStarter;
  label: string;
  /** Provider-agnostic model ID; matches both "gpt-image-2.5-flare" and "openai/gpt-image-2.5-flare". */
  modelId?: string;
}

export const ASSET_CANVAS_QUICK_STARTS: readonly AssetCanvasQuickStart[] = [
  { key: "image", type: "image", label: "Image" },
  { key: "video", type: "video", label: "Video" },
  { key: "model-3d", type: "model-3d", label: "3D" },
  { key: "gpt-image-2.5", type: "image", label: "GPT Image 2.5", modelId: "gpt-image-2.5-flare" },
  { key: "nano-banana-2", type: "image", label: "Nano Banana 2", modelId: "gemini-3.1-flash-image" },
  { key: "seedance-2.0", type: "video", label: "Seedance 2.0", modelId: "seedance-2.0" },
  { key: "seedance-2.5", type: "video", label: "Seedance 2.5", modelId: "seedance-2.5" },
];

/** Hides model-specific starters whose model the configured providers do not offer. */
export function availableQuickStarts(
  imageModels: readonly ImageModel[],
  videoModels: readonly VideoModel[],
  quickStarts: readonly AssetCanvasQuickStart[] = ASSET_CANVAS_QUICK_STARTS,
): AssetCanvasQuickStart[] {
  return quickStarts.filter((item) => {
    if (!item.modelId) return true;
    const models = item.type === "image" ? imageModels : item.type === "video" ? videoModels : [];
    return models.some((model) => matchesModelId(model.id, item.modelId!));
  });
}

export async function createAssetCanvasQuickStart(item: AssetCanvasQuickStart): Promise<{ project: ProjectState; nodeId: string }> {
  const { document, nodeId } = createAssetCanvasStarterDocument(item.type, await starterOptions(item));
  const project = await createProject({ type: "asset-canvas" });
  try {
    await updateAssetCanvas(project.id, document);
  } catch (cause) {
    try {
      await deleteProject(project.id);
    } catch {
      throw new Error(`${errorMessage(cause)}. The empty canvas could not be removed.`);
    }
    throw cause;
  }
  return { project, nodeId };
}

async function starterOptions(item: AssetCanvasQuickStart): Promise<Parameters<typeof createAssetCanvasStarterDocument>[1]> {
  if (item.type === "image") {
    const model = pickModel(item, await listImageModels());
    const option = preferredImageOption(model);
    return model ? {
      imageModel: { provider: model.provider, id: model.id },
      ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
    } : {};
  }
  if (item.type === "video") {
    const model = pickModel(item, await listVideoModels());
    return model ? { videoModel: { provider: model.provider, id: model.id }, videoAspectRatio: model.aspectRatios[0] } : {};
  }
  return {};
}

// Generic starters take the first available model, like a new node on the canvas does.
function pickModel<Model extends { id: string }>(item: AssetCanvasQuickStart, models: readonly Model[]): Model | undefined {
  if (!item.modelId) return models[0];
  const model = models.find((candidate) => matchesModelId(candidate.id, item.modelId!));
  if (!model) throw new Error(`${item.label} is not available`);
  return model;
}

function matchesModelId(id: string, modelId: string): boolean {
  return id === modelId || id.endsWith(`/${modelId}`);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
