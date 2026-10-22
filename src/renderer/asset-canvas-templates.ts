import type {
  AssetCanvasDocument,
  AssetCanvasNode,
  ImageModel,
} from "../shared/contracts.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
  preferredImageOption,
} from "../shared/asset-canvas.js";
import {
  createProject,
  deleteProject,
  listImageModels,
} from "./api.js";
import {
  createCanvasBoard,
  deleteCanvasBoard,
  getCanvasBoard,
  getCanvasWorkspace,
  saveCanvasBoard,
} from "./canvas-api.js";
import { t } from "./i18n.js";

export const ASSET_CANVAS_TEMPLATES = [
  "free-image",
  "free-sequence",
  "action-set",
] as const;
export type AssetCanvasTemplate = (typeof ASSET_CANVAS_TEMPLATES)[number];

const ACTIONS = [
  { key: "idle", label: "idle", loop: true },
  { key: "walk", label: "walking", loop: true },
  { key: "run", label: "running", loop: true },
  { key: "attack", label: "attacking", loop: false },
  { key: "hurt", label: "taking damage", loop: false },
  { key: "down", label: "falling down", loop: false },
] as const;

export function createAssetCanvasTemplateDocument(
  template: AssetCanvasTemplate,
  imageModels: readonly ImageModel[],
  sourceAssetId?: string,
): { document: AssetCanvasDocument; focusNodeId: string } {
  const document = createAssetCanvasDocument();
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "text",
    title: t(`assetCanvasTemplates.${template}.title`),
    position: { x: 40, y: 80 },
    data: {
      text: t(`assetCanvasTemplates.${template}.guide`),
      instruction: "",
    },
  };
  const nodes: AssetCanvasNode[] = [guide];
  const imageModel =
    (template === "free-image"
      ? imageModels[0]
      : imageModels.find(
          (model) =>
            model.supportsReferenceImage && model.maxReferenceImages !== 0,
        )) ?? imageModels[0];
  const imageOption = preferredImageOption(
    imageModel,
    template === "free-image" ? "1:1" : "4:3",
  );

  if (template === "free-image") {
    const image = createAssetGenerationNode(
      "image",
      { x: 540, y: 80 },
      {
        ...(imageModel
          ? { imageModel: { provider: imageModel.provider, id: imageModel.id } }
          : {}),
        ...(imageOption
          ? {
              imageResolution: imageOption.resolution,
              imageAspectRatio: imageOption.aspectRatio,
            }
          : {}),
      },
    ) as Extract<AssetCanvasNode, { type: "image" }>;
    image.title = t("assetCanvasTemplates.free-image.generator");
    image.data.presetId = "free";
    nodes.push(image);
    document.nodes = nodes;
    document.editorLayout.nodes = Object.fromEntries(
      nodes.map((node) => [node.id, node.position]),
    );
    return { document, focusNodeId: image.id };
  }

  const source: AssetCanvasNode = sourceAssetId
    ? {
        id: crypto.randomUUID(),
        type: "asset",
        title: t("assetCanvasTemplates.reference"),
        position: { x: 540, y: 80 },
        data: { assetId: sourceAssetId, mediaType: "image" },
      }
    : createSourceInput();
  function createSourceInput(): Extract<AssetCanvasNode, { type: "image" }> {
    const node = createAssetGenerationNode(
      "image",
      { x: 540, y: 80 },
      {
        ...(imageModel
          ? { imageModel: { provider: imageModel.provider, id: imageModel.id } }
          : {}),
        ...(imageOption
          ? {
              imageResolution: imageOption.resolution,
              imageAspectRatio: imageOption.aspectRatio,
            }
          : {}),
      },
    ) as Extract<AssetCanvasNode, { type: "image" }>;
    node.title = t("assetCanvasTemplates.reference");
    node.data.sourceInput = true;
    return node;
  }
  nodes.push(source);

  if (template === "free-sequence") {
    const sequence = createAssetGenerationNode(
      "image",
      { x: 1040, y: 80 },
      {
        ...(imageModel
          ? { imageModel: { provider: imageModel.provider, id: imageModel.id } }
          : {}),
        ...(imageOption
          ? {
              imageResolution: imageOption.resolution,
              imageAspectRatio: imageOption.aspectRatio,
            }
          : {}),
      },
    ) as Extract<AssetCanvasNode, { type: "image" }>;
    sequence.title = t("assetCanvasTemplates.free-sequence.generator");
    sequence.data.presetId = "continuous-sequence";
    sequence.data.images = [{ type: "node", nodeId: source.id }];
    nodes.push(sequence);
  } else {
    for (const [index, action] of ACTIONS.entries()) {
      const image = createAssetGenerationNode(
        "image",
        { x: 1040 + (index % 2) * 520, y: 80 + Math.floor(index / 2) * 560 },
        {
          ...(imageModel
            ? {
                imageModel: {
                  provider: imageModel.provider,
                  id: imageModel.id,
                },
              }
            : {}),
          ...(imageOption
            ? {
                imageResolution: imageOption.resolution,
                imageAspectRatio: imageOption.aspectRatio,
              }
            : {}),
        },
      ) as Extract<AssetCanvasNode, { type: "image" }>;
      image.title = t(`assetCanvasTemplates.actions.${action.key}`);
      image.data.images = [{ type: "node", nodeId: source.id }];
      image.data.prompt = `Use the supplied image as the exact character reference. Create one sprite sheet showing 12 successive frames of the character ${action.label}, arranged in a 3-row by 4-column grid, read left to right. Keep the same face, outfit, colors, proportions, scale, and camera angle in every frame. Use equal-sized cells, consistent baselines, a plain background, and no labels or extra characters. ${action.loop ? "Make the last frame transition smoothly to the first." : "Show a complete action progression from start to finish; do not loop the last frame to the first."}`;
      nodes.push(image);
    }
  }

  document.nodes = nodes;
  document.editorLayout.nodes = Object.fromEntries(
    nodes.map((node) => [node.id, node.position]),
  );
  return { document, focusNodeId: source.id };
}

export async function createAssetCanvasTemplateProject(
  template: AssetCanvasTemplate,
): Promise<{ projectId: string; nodeId: string }> {
  const imageModels = await listImageModels().catch(() => []);
  const { document, focusNodeId } = createAssetCanvasTemplateDocument(
    template,
    imageModels,
  );
  const project = await createProject({
    type: "asset-canvas",
    name: t(`assetCanvasTemplates.${template}.title`),
  });
  try {
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    await saveCanvasBoard(project.id, {
      board: { ...document, id: current.board.id },
      revision: current.revision,
    });
    return { projectId: project.id, nodeId: focusNodeId };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    throw cause;
  }
}

export async function createAssetCanvasTemplateBoard(
  projectId: string,
  template: Exclude<AssetCanvasTemplate, "free-image">,
  sourceAssetId: string,
): Promise<{ boardId: string; nodeId: string }> {
  const imageModels = await listImageModels().catch(() => []);
  const { document, focusNodeId } = createAssetCanvasTemplateDocument(
    template,
    imageModels,
    sourceAssetId,
  );
  const workspace = await createCanvasBoard(
    projectId,
    t(`assetCanvasTemplates.${template}.title`),
  );
  const boardId = workspace.boards.at(-1)!.id;
  try {
    const current = await getCanvasBoard(projectId, boardId);
    await saveCanvasBoard(projectId, {
      board: { ...document, id: boardId },
      revision: current.revision,
    });
    return { boardId, nodeId: focusNodeId };
  } catch (cause) {
    await deleteCanvasBoard(projectId, boardId).catch(() => undefined);
    throw cause;
  }
}
