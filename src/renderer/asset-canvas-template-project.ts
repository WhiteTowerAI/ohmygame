import { PIXEL_ART_LEVELS, type PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { AssetCanvasNode } from "../shared/contracts.js";
import { expandCanvasGroups, layoutPixelLevelGroups } from "./canvas-groups.js";
import {
  createPixelAssetWorkflowNodes,
  pixelAssetCategoryTemplateLabel,
  pixelAssetReferenceNode,
  pixelAssetPresetLabel,
  pixelAssetPresetUsage,
  pixelAssetTemplatePresetIds,
  type PixelAssetPresetId,
  type PixelAssetTemplateCategory,
} from "./asset-canvas-pixel-workflows.js";
import { createProject, deleteProject, listImageModels } from "./api.js";
import { getCanvasBoard, getCanvasWorkspace, saveCanvasBoard } from "./canvas-api.js";
import { workspaceVersion } from "./workspace-version.js";
import { t } from "./i18n.js";

const OUTPUT_START = { x: 484, y: 72 };
const OUTPUT_COLUMN_GAP = 460;
const OUTPUT_ROW_GAP = 480;

export async function createPixelAssetTemplateProject(category: PixelAssetTemplateCategory): Promise<{ projectId: string; nodeId: string }> {
  const project = await createProject({ name: pixelAssetCategoryTemplateLabel(category), type: "asset-canvas" });

  try {
    const [workspace, imageModels] = await Promise.all([getCanvasWorkspace(project.id), listImageModels()]);
    const entry = workspace.boards[0];
    if (!entry) throw new Error(t("assetCanvas.pixelPresets.templateCanvasUnavailable"));
    const detail = await getCanvasBoard(project.id, entry.id);
    const levelGroups = new Map(PIXEL_ART_LEVELS.map((level) => [
      level,
      detail.board.nodes.find((node) => node.type === "group" && node.data.pixelStyle === level),
    ]));
    if ([...levelGroups.values()].some((group) => !group || group.type !== "group")) throw new Error(t("assetCanvas.pixelPresets.templateCanvasUnavailable"));

    let nodeId = "";
    const additions = PIXEL_ART_LEVELS.flatMap((level) => {
      const group = levelGroups.get(level)!;
      const workflow = createCategoryWorkflow(category, level, imageModels, group.id);
      if (level === "classic") nodeId = workflow.outputNodeId;
      return workflow.nodes;
    });
    const workflowNodes = layoutPixelLevelGroups(expandCanvasGroups([...detail.board.nodes, ...additions]));
    const firstGroup = workflowNodes.find((node) => node.type === "group" && node.data.pixelStyle)!;
    const introduction: AssetCanvasNode = {
      id: crypto.randomUUID(),
      type: "text",
      title: t("assetCanvas.pixelPresets.introductionTitle", { category: t(`assetCanvas.pixelPresets.categories.${category}`) }),
      position: { x: firstGroup.position.x, y: firstGroup.position.y - 600 },
      width: 760,
      data: {
        instruction: `pixel-asset-template:${category}`,
        text: [
          t(`assetCanvas.pixelPresets.templateDescriptions.${category}`),
          t("assetCanvas.pixelPresets.introduction"),
          ...pixelAssetTemplatePresetIds(category).map((id) => `${pixelAssetPresetLabel(id)}: ${pixelAssetPresetUsage(id)}`),
        ].join("\n\n"),
      },
    };
    const nodes = [introduction, ...workflowNodes];
    const layoutNodes = Object.fromEntries(nodes.map((node) => [node.id, {
      ...node.position,
      ...(node.width !== undefined ? { width: node.width } : {}),
      ...(node.height !== undefined ? { height: node.height } : {}),
    }]));
    const board = {
      ...detail.board,
      nodes,
      editorLayout: { ...detail.board.editorLayout, nodes: layoutNodes, fitView: true },
    };
    await saveCanvasBoard(project.id, { board, revision: detail.revision }, workspaceVersion(project.id));
    return { projectId: project.id, nodeId };
  } catch (cause) {
    await deleteProject(project.id).catch(() => undefined);
    throw cause;
  }
}

function createCategoryWorkflow(category: PixelAssetTemplateCategory, level: PixelArtLevel, imageModels: Awaited<ReturnType<typeof listImageModels>>, parentId: string) {
  const presetIds = pixelAssetTemplatePresetIds(category);
  if (category === "skins") {
    const workflow = createPixelAssetWorkflowNodes(presetIds[0] as PixelAssetPresetId, level, imageModels, parentId);
    return { nodes: workflow.nodes, outputNodeId: workflow.outputNodeId };
  }

  const rows = Math.ceil(presetIds.length / 2);
  const reference = pixelAssetReferenceNode(level, parentId, {
    x: 24,
    y: OUTPUT_START.y + Math.floor((rows - 1) / 2) * OUTPUT_ROW_GAP,
  });
  const nodes: AssetCanvasNode[] = [reference];
  let outputNodeId = "";
  presetIds.forEach((presetId, index) => {
    const workflow = createPixelAssetWorkflowNodes(presetId, level, imageModels, parentId, reference.id);
    const output = workflow.nodes.find((node) => node.id === workflow.outputNodeId);
    if (output) {
      output.position = {
        x: OUTPUT_START.x + (index % 2) * OUTPUT_COLUMN_GAP,
        y: OUTPUT_START.y + Math.floor(index / 2) * OUTPUT_ROW_GAP,
      };
    }
    if (!outputNodeId) outputNodeId = workflow.outputNodeId;
    nodes.push(...workflow.nodes);
  });
  return { nodes, outputNodeId };
}
