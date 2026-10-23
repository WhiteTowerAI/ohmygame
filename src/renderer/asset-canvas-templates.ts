import type {
  AssetCanvasDocument,
  AssetCanvasNode,
  ImageModel,
} from "../shared/contracts.js";
import { CANVAS_IMAGE_PRESETS, QUICK_RESKIN_DEFAULT_PROMPT, canvasImagePresetPrompt, type CanvasImagePreset } from "../shared/canvas-image-presets.js";
import { preferredCharacterSheetOption } from "../shared/canvas-character-tools.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
  preferredImageOption,
} from "../shared/asset-canvas.js";
import { createProject, deleteLibraryAsset, deleteProject, listImageModels, uploadLibraryAsset } from "./api.js";
import { TEMPLATE_SAMPLE_IMAGES, type TemplateSample } from "./asset-canvas-template-samples.js";
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

const SEQUENCE_PRESETS = ["continuous-sequence", "consistent-sequence"] as const;
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
  const model = template === "pixel-art" || template === "free-sequence" || template === "quick-reskin"
    ? imageModels.find((candidate) => candidate.supportsReferenceImage && (candidate.maxReferenceImages ?? 16) >= (template === "quick-reskin" ? 2 : 1))
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

export interface AssetCanvasTemplateInput {
  prompt?: string;
  sourceAssetId?: string;
}

async function uploadTemplateSample(sample: TemplateSample): Promise<string> {
  const response = await fetch(TEMPLATE_SAMPLE_IMAGES[sample]);
  if (!response.ok) throw new Error(`Could not load the template example: ${sample}`);
  const file = new File([await response.blob()], `${sample}.webp`, { type: "image/webp" });
  return (await uploadLibraryAsset(file, "image/webp", undefined, "reference")).id;
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
): { document: AssetCanvasDocument; focusNodeId: string; outputNodeIds: string[]; sampleImages: Map<string, TemplateSample> } {
  const document = createAssetCanvasDocument();
  const sampleImages = new Map<string, TemplateSample>();
  document.editorLayout.viewport = { x: 24, y: 100, zoom: 0.75 };
  const guide: AssetCanvasNode = {
    id: crypto.randomUUID(),
    type: "text",
    title: t(`assetCanvasTemplates.${template}.title`),
    position: { x: 40, y: 80 },
    width: template === "action-set" ? 400 : 480,
    data: {
      text: t(`assetCanvasTemplates.${template}.guide`),
      instruction: `asset-canvas-template:${template}`,
    },
  };
  const nodes: AssetCanvasNode[] = [guide];
  const outputNodeIds: string[] = [];
  const prompt = input.prompt?.trim() ?? "";
  const imageModel =
    (template === "character-sheet" && !input.sourceAssetId
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
    return { document, focusNodeId, outputNodeIds, sampleImages };
  }

  function referenceNode(): AssetCanvasNode {
    const title = t(template === "quick-reskin" ? "assetCanvasTemplates.quickReskinSource" : "assetCanvasTemplates.reference");
    if (input.sourceAssetId) return {
      id: crypto.randomUUID(),
      type: "asset",
      title,
      position: { x: 560, y: 80 },
      data: { assetId: input.sourceAssetId, mediaType: "image" },
    };
    const node = imageNode(560, 80);
    node.title = title;
    node.data.sourceInput = true;
    if (template === "quick-reskin") node.data.sourceInputLabel = t("assetCanvasTemplates.quickReskinPerson");
    sampleImages.set(node.id, "character-sheet");
    return node;
  }

  if (template === "pixel-art" || template === "character-sheet") {
    const presets = template === "pixel-art" ? PIXEL_IMAGE_PRESETS : ["character-sheet"] as const;
    const source = template === "pixel-art" ? referenceNode() : undefined;
    if (source) nodes.push(source);
    for (const [index, preset] of presets.entries()) {
      const image = createTemplatePresetNode(template, preset, imageModels, {
        x: (source ? 1100 : 560) + (index % 2) * 520,
        y: 80 + Math.floor(index / 2) * 640,
      }, source?.id);
      image.data.prompt = canvasImagePresetPrompt(preset, prompt, template === "pixel-art" ? "pixel" : undefined, source ? 1 : 0);
      image.data.promptExpanded = true;
      if (preset !== "free") sampleImages.set(image.id, preset);
      nodes.push(image);
      outputNodeIds.push(image.id);
    }
    return finish(outputNodeIds[0]!);
  }

  const source = referenceNode();
  nodes.push(source);

  if (template === "quick-reskin") {
    const image = createTemplatePresetNode(template, "quick-reskin", imageModels, { x: 1100, y: 80 }, source.id);
    image.data.quickReskinMode = "person-clothing";
    image.data.prompt = prompt || QUICK_RESKIN_DEFAULT_PROMPT;
    const clothingSource = imageNode(560, 700);
    clothingSource.title = t("assetCanvasTemplates.quickReskinClothing");
    clothingSource.data.sourceInput = true;
    clothingSource.data.sourceInputLabel = t("assetCanvasTemplates.quickReskinClothing");
    sampleImages.set(clothingSource.id, "clothing");
    sampleImages.set(image.id, "quick-reskin");
    nodes.push(clothingSource);
    image.data.images = [
      { type: "node", nodeId: source.id },
      { type: "node", nodeId: clothingSource.id },
    ];
    nodes.push(image);
    outputNodeIds.push(image.id);
  } else if (template === "free-sequence") {
    for (const [index, preset] of SEQUENCE_PRESETS.entries()) {
      const sequence = createTemplatePresetNode("free-sequence", preset, imageModels, { x: 1100 + (index % 2) * 520, y: 80 + Math.floor(index / 2) * 640 }, source.id);
      sequence.data.prompt = canvasImagePresetPrompt(preset, prompt, undefined, 1);
      sequence.data.promptExpanded = true;
      sampleImages.set(sequence.id, preset);
      nodes.push(sequence);
      outputNodeIds.push(sequence.id);
    }
  } else {
    for (const [index, action] of ACTIONS.entries()) {
      const image = imageNode(
        1100 + (index % 2) * 520,
        80 + Math.floor(index / 2) * 640,
      );
      image.title = t(`assetCanvasTemplates.actions.${action.key}`);
      sampleImages.set(image.id, action.key);
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
  const project = await createProject({
    type: "asset-canvas",
    name: t(`assetCanvasTemplates.${template}.title`),
  });
  const sampleAssetIds = new Map<TemplateSample, string>();
  try {
    const { document, focusNodeId, outputNodeIds, sampleImages } = createAssetCanvasTemplateDocument(
      template,
      imageModels,
      input,
    );
    const workspace = await getCanvasWorkspace(project.id);
    const current = await getCanvasBoard(project.id, workspace.boards[0]!.id);
    if (!input.sourceAssetId && !input.prompt?.trim()) {
      for (const node of document.nodes) {
        const sample = sampleImages.get(node.id);
        if (node.type !== "image" || !sample) continue;
        let assetId = sampleAssetIds.get(sample);
        if (!assetId) {
          assetId = await uploadTemplateSample(sample);
          sampleAssetIds.set(sample, assetId);
        }
        node.data.assetId = assetId;
      }
    }
    await saveCanvasBoard(project.id, {
      board: { ...document, id: current.board.id },
      revision: current.revision,
    });
    await changeCanvasBoard(project.id, current.board.id, { name: t(`assetCanvasTemplates.${template}.title`) });
    return { projectId: project.id, boardId: current.board.id, nodeId: focusNodeId, outputNodeIds };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    for (const assetId of sampleAssetIds.values()) await deleteLibraryAsset(assetId).catch(() => undefined);
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
