import type { ImageModel, ProjectState, VideoModel } from "../shared/contracts.js";
import { createAssetCanvasStarterDocument, preferredImageOption, type AssetCanvasStarter } from "../shared/asset-canvas.js";
import { createProject, deleteProject, listImageModels, listVideoModels, waitForRuntime } from "./api.js";
import { getCanvasWorkspace, getCanvasBoard, saveCanvasBoard } from "./canvas-api.js";

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

/** Thrown when no connected provider offers a model-specific starter's model. */
export class QuickStartModelUnavailableError extends Error {
  constructor(item: AssetCanvasQuickStart) {
    super(`${item.label} needs a provider that offers it.`);
    this.name = "QuickStartModelUnavailableError";
  }
}

type MediaModels = { image: ImageModel[]; video: VideoModel[] };

// Provider catalogs can take seconds, so the app loads them ahead of a click and starters reuse the result.
let cachedModels: MediaModels | undefined;
let pendingModels: Promise<MediaModels> | undefined;

/** Refreshes the media model lists, joining a load already in flight. */
export function loadQuickStartModels(): Promise<MediaModels> {
  pendingModels ??= waitForRuntime()
    .then(() => Promise.all([listImageModels().catch(() => []), listVideoModels().catch(() => [])]))
    .catch(() => [[], []] as [ImageModel[], VideoModel[]])
    .then(([image, video]) => {
      cachedModels = { image, video };
      return cachedModels;
    })
    .finally(() => { pendingModels = undefined; });
  return pendingModels;
}

export async function createAssetCanvasQuickStart(item: AssetCanvasQuickStart): Promise<{ project: ProjectState; nodeId: string }> {
  const { document, nodeId } = createAssetCanvasStarterDocument(item.type, starterOptions(item, await modelsFor(item)));
  const project = await createProject({ type: "asset-canvas" });
  try {
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    await saveCanvasBoard(project.id, { board: { ...document, id: current.board.id }, revision: current.revision });
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

// A model the cached lists lack may come from a provider connected since, so look again before giving up.
async function modelsFor(item: AssetCanvasQuickStart): Promise<MediaModels> {
  if (cachedModels && (!item.modelId || hasModel(item, cachedModels))) return cachedModels;
  const models = await loadQuickStartModels();
  if (item.modelId && !hasModel(item, models)) throw new QuickStartModelUnavailableError(item);
  return models;
}

function hasModel(item: AssetCanvasQuickStart, models: MediaModels): boolean {
  return Boolean(item.modelId) && starterModels(item, models).some((model) => matchesModelId(model.id, item.modelId!));
}

function starterModels(item: AssetCanvasQuickStart, models: MediaModels): ReadonlyArray<ImageModel | VideoModel> {
  return item.type === "image" ? models.image : item.type === "video" ? models.video : [];
}

function starterOptions(item: AssetCanvasQuickStart, models: MediaModels): Parameters<typeof createAssetCanvasStarterDocument>[1] {
  if (item.type === "image") {
    const model = pickModel(item, models.image);
    const option = preferredImageOption(model);
    return model ? {
      imageModel: { provider: model.provider, id: model.id },
      ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
    } : {};
  }
  if (item.type === "video") {
    const model = pickModel(item, models.video);
    return model ? { videoModel: { provider: model.provider, id: model.id }, videoAspectRatio: model.aspectRatios[0], videoReferenceMode: model.imageReferenceMode } : {};
  }
  return {};
}

// Generic starters take the first available model, like a new node on the canvas does.
function pickModel<Model extends { id: string }>(item: AssetCanvasQuickStart, models: readonly Model[]): Model | undefined {
  return item.modelId ? models.find((model) => matchesModelId(model.id, item.modelId!)) : models[0];
}

function matchesModelId(id: string, modelId: string): boolean {
  if (id === modelId || id.endsWith(`/${modelId}`)) return true;
  const normalizedId = id.toLowerCase().replaceAll(".", "-");
  const normalizedModelId = modelId.toLowerCase().replaceAll(".", "-");
  if (!normalizedModelId.startsWith("seedance-")) return false;
  return normalizedId.split("/").pop()?.includes(normalizedModelId) ?? false;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
