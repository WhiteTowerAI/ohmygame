import type {
  AssetCanvasDocument,
  AssetCanvasNode,
  ImageModel,
} from "../shared/contracts.js";
import { CANVAS_IMAGE_PRESETS, type CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { preferredCharacterSheetOption } from "../shared/canvas-character-tools.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
  preferredImageOption,
} from "../shared/asset-canvas.js";
import { createProject, deleteProject, listImageModels } from "./api.js";
import {
  changeCanvasBoard,
  createCanvasBoard,
  deleteCanvasBoard,
  getCanvasBoard,
  getCanvasWorkspace,
  saveCanvasBoard,
} from "./canvas-api.js";
import { t } from "./i18n.js";

export const ASSET_CANVAS_TEMPLATES = [
  "pixel-art",
  "character-sheet",
  "quick-reskin",
  "free-sequence",
  "action-set",
] as const;
export type AssetCanvasTemplate = (typeof ASSET_CANVAS_TEMPLATES)[number];

export function templateGuideInfo(instruction?: string): { template: AssetCanvasTemplate } | undefined {
  const legacy = instruction === "asset-canvas-template:free-image" || instruction === "asset-canvas-template:free-image:pixel"
    ? "pixel-art"
    : instruction === "asset-canvas-template:free-image:general" ? "character-sheet" : undefined;
  const template = legacy ?? ASSET_CANVAS_TEMPLATES.find((candidate) => instruction === `asset-canvas-template:${candidate}`);
  return template ? { template } : undefined;
}

const SEQUENCE_PRESETS: readonly CanvasImagePreset[] = ["continuous-sequence", "consistent-sequence"];
const PIXEL_IMAGE_PRESETS = CANVAS_IMAGE_PRESETS.filter((preset) => !["free", "continuous-sequence", "consistent-sequence", "character-sheet", "quick-reskin"].includes(preset));

export function templateImagePresets(template?: AssetCanvasTemplate): readonly CanvasImagePreset[] {
  if (template === "free-sequence") return SEQUENCE_PRESETS;
  if (template === "pixel-art") return PIXEL_IMAGE_PRESETS;
  if (template === "character-sheet") return ["character-sheet"];
  if (template === "quick-reskin") return ["quick-reskin"];
  if (template === "action-set") return [];
  return CANVAS_IMAGE_PRESETS;
}

export function createTemplatePresetNode(
  template: Exclude<AssetCanvasTemplate, "action-set">,
  preset: CanvasImagePreset,
  imageModels: readonly ImageModel[],
  position: { x: number; y: number },
  sourceNodeId?: string,
): Extract<AssetCanvasNode, { type: "image" }> {
  const model = template === "free-sequence" || template === "quick-reskin"
    ? imageModels.find((candidate) => candidate.supportsReferenceImage && candidate.maxReferenceImages !== 0)
    : imageModels[0];
  const option = preset === "character-sheet"
    ? preferredCharacterSheetOption(model)
    : preferredImageOption(model, template === "free-sequence" ? "4:3" : "1:1");
  const node = createAssetGenerationNode("image", position, {
    ...(model ? { imageModel: { provider: model.provider, id: model.id } } : {}),
    ...(option ? { imageResolution: option.resolution, imageAspectRatio: option.aspectRatio } : {}),
  }) as Extract<AssetCanvasNode, { type: "image" }>;
  node.title = t(`assetCanvas.imagePresets.${preset}`);
  node.data.presetId = preset;
  if (sourceNodeId) node.data.images = [{ type: "node", nodeId: sourceNodeId }];
  return node;
}

export function nextTemplatePresetPosition(
  template: Exclude<AssetCanvasTemplate, "action-set">,
  nodes: readonly AssetCanvasNode[],
): { x: number; y: number } {
  const outputs = nodes.filter((node) => node.type === "image" && !node.data.sourceInput);
  const firstX = template === "pixel-art" || template === "character-sheet" ? 560 : 1100;
  if (!outputs.length) return { x: firstX, y: 80 };
  const bottom = Math.max(...outputs.map((node) => node.position.y + (node.height ?? 560)));
  return { x: firstX, y: Math.ceil((bottom + 64) / 20) * 20 };
}

export interface AssetCanvasTemplateInput {
  prompt?: string;
  presetId?: CanvasImagePreset;
  sourceAssetId?: string;
}

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
  input: AssetCanvasTemplateInput = {},
): { document: AssetCanvasDocument; focusNodeId: string; outputNodeIds: string[] } {
  const document = createAssetCanvasDocument();
  document.editorLayout.viewport = { x: 24, y: 100, zoom: 0.75 };
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "text",
    title: t(`assetCanvasTemplates.${template}.title`),
    position: { x: 40, y: 80 },
    width: template === "pixel-art" || template === "free-sequence" ? 480 : 400,
    height: template === "pixel-art" ? 620 : template === "free-sequence" ? 500 : 340,
    data: {
      text: t(`assetCanvasTemplates.${template}.guide`),
      instruction: `asset-canvas-template:${template}`,
    },
  };
  const nodes: AssetCanvasNode[] = [guide];
  const outputNodeIds: string[] = [];
  const prompt = input.prompt?.trim() ?? "";
  const imageModel =
    ((template === "pixel-art" || template === "character-sheet") && !input.sourceAssetId
      ? imageModels[0]
      : imageModels.find(
          (model) =>
            model.supportsReferenceImage && model.maxReferenceImages !== 0,
        ));
  const imageOption = template === "character-sheet"
    ? preferredCharacterSheetOption(imageModel)
    : preferredImageOption(imageModel, template === "pixel-art" || template === "quick-reskin" ? "1:1" : "4:3");

  function imageNode(
    x: number,
    y: number,
  ): Extract<AssetCanvasNode, { type: "image" }> {
    return createAssetGenerationNode(
      "image",
      { x, y },
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
  }

  function finish(focusNodeId: string) {
    document.nodes = nodes;
    document.editorLayout.nodes = Object.fromEntries(nodes.map((node) => [
      node.id,
      { ...node.position, ...(node.width ? { width: node.width } : {}), ...(node.height ? { height: node.height } : {}) },
    ]));
    return { document, focusNodeId, outputNodeIds };
  }

  if (template === "pixel-art" || template === "character-sheet") {
    const preset = template === "pixel-art" && input.presetId && PIXEL_IMAGE_PRESETS.some((item) => item === input.presetId) ? input.presetId : template === "pixel-art" ? "side-view-character" : "character-sheet";
    const image = createTemplatePresetNode(template, preset, input.sourceAssetId ? imageModels.filter((model) => model.supportsReferenceImage && model.maxReferenceImages !== 0) : imageModels, { x: 560, y: 80 });
    image.data.prompt = prompt;
    if (input.sourceAssetId) image.data.images = [{ type: "library", assetId: input.sourceAssetId }];
    nodes.push(image);
    outputNodeIds.push(image.id);
    return finish(image.id);
  }

  const source: AssetCanvasNode = input.sourceAssetId
    ? {
        id: crypto.randomUUID(),
        type: "asset",
        title: t(template === "quick-reskin" ? "assetCanvasTemplates.quickReskinSource" : "assetCanvasTemplates.reference"),
        position: { x: 560, y: 80 },
        data: { assetId: input.sourceAssetId, mediaType: "image" },
      }
    : createSourceInput();
  function createSourceInput(): Extract<AssetCanvasNode, { type: "image" }> {
    const node = imageNode(560, 80);
    node.title = t(template === "quick-reskin" ? "assetCanvasTemplates.quickReskinSource" : "assetCanvasTemplates.reference");
    node.data.sourceInput = true;
    return node;
  }
  nodes.push(source);

  if (template === "quick-reskin") {
    const image = createTemplatePresetNode(template, "quick-reskin", imageModels, { x: 1100, y: 80 }, source.id);
    image.data.prompt = prompt;
    nodes.push(image);
    outputNodeIds.push(image.id);
  } else if (template === "free-sequence") {
    const sequence = createTemplatePresetNode("free-sequence", input.presetId === "consistent-sequence" ? "consistent-sequence" : "continuous-sequence", imageModels, { x: 1100, y: 80 }, source.id);
    sequence.data.prompt = prompt;
    nodes.push(sequence);
    outputNodeIds.push(sequence.id);
  } else {
    for (const [index, action] of ACTIONS.entries()) {
      const image = imageNode(
        1100 + (index % 2) * 520,
        80 + Math.floor(index / 2) * 640,
      );
      image.title = t(`assetCanvasTemplates.actions.${action.key}`);
      image.data.images = [{ type: "node", nodeId: source.id }];
      image.data.prompt = `Use the supplied image as the exact character reference. Create one sprite sheet showing 12 successive frames of the character ${action.label}, arranged in a 3-row by 4-column grid, read left to right. Keep the same face, outfit, colors, proportions, scale, and camera angle in every frame. Use equal-sized cells, consistent baselines, a plain background, and no labels or extra characters. ${action.loop ? "Make the last frame transition smoothly to the first." : "Show a complete action progression from start to finish; do not loop the last frame to the first."}${prompt ? ` Additional direction: ${prompt}` : ""}`;
      nodes.push(image);
      outputNodeIds.push(image.id);
    }
  }

  return finish(source.id);
}

export async function createAssetCanvasTemplateProject(
  template: AssetCanvasTemplate,
  input: AssetCanvasTemplateInput = {},
): Promise<{ projectId: string; boardId: string; nodeId: string; outputNodeIds: string[] }> {
  const imageModels = await listImageModels().catch(() => []);
  const { document, focusNodeId, outputNodeIds } = createAssetCanvasTemplateDocument(
    template,
    imageModels,
    input,
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
    await changeCanvasBoard(project.id, current.board.id, { name: t(`assetCanvasTemplates.${template}.title`) });
    return { projectId: project.id, boardId: current.board.id, nodeId: focusNodeId, outputNodeIds };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    throw cause;
  }
}

export async function createAssetCanvasTemplateBoard(
  projectId: string,
  template: AssetCanvasTemplate,
  sourceAssetId: string,
): Promise<{ boardId: string; nodeId: string }> {
  const imageModels = await listImageModels().catch(() => []);
  const { document, focusNodeId } = createAssetCanvasTemplateDocument(
    template,
    imageModels,
    { sourceAssetId },
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
