import type { PixelArtLevel } from "../shared/canvas-pixel-style.js";
import type { AssetCanvasNode, ImageResolution, ImageAspectRatio } from "../shared/contracts.js";
import { expandCanvasGroups } from "./canvas-groups.js";
import {
  createPixelAssetWorkflowNodes,
  PIXEL_ASSET_TEMPLATE_NOTE,
  pixelAssetCategoryTemplateLabel,
  pixelAssetReferenceNode,
  pixelAssetPresetLabel,
  pixelAssetPresetUsage,
  pixelAssetTemplatePresetIds,
  type PixelAssetPresetId,
  type PixelAssetTemplateCategory,
} from "./asset-canvas-pixel-workflows.js";
import { pixelPresetGifExampleId, pixelTemplateReferenceExampleId } from "./asset-canvas-pixel-examples.js";
import { createProject, deleteProject, listImageModels } from "./api.js";
import { getCanvasBoard, getCanvasWorkspace, saveCanvasBoard } from "./canvas-api.js";
import { workspaceVersion } from "./workspace-version.js";
import { t } from "./i18n.js";

const OUTPUT_START = { x: 484, y: 72 };
const OUTPUT_COLUMN_GAP = 460;
const OUTPUT_ROW_GAP = 480;
const GUIDE_WIDTH = 760;
/** Rough rendered heights of the guide (label and paragraphs, plus each use row) and of a step text node. */
const GUIDE_BASE_HEIGHT = 190;
const GUIDE_ROW_HEIGHT = 50;
const STEP_HEIGHT = 200;
const STEP_GAP = 48;

/** Builds one pixel-density group for the category; the new board's other density groups are removed. */
export async function createPixelAssetTemplateProject(category: PixelAssetTemplateCategory, level: PixelArtLevel): Promise<{ projectId: string; nodeId: string }> {
  const project = await createProject({ name: pixelAssetCategoryTemplateLabel(category, level), type: "asset-canvas" });

  try {
    const [workspace, imageModels] = await Promise.all([getCanvasWorkspace(project.id), listImageModels()]);
    const entry = workspace.boards[0];
    if (!entry) throw new Error(t("assetCanvas.pixelPresets.templateCanvasUnavailable"));
    const detail = await getCanvasBoard(project.id, entry.id);
    const group = detail.board.nodes.find((node) => node.type === "group" && node.data.pixelStyle === level);
    if (!group) throw new Error(t("assetCanvas.pixelPresets.templateCanvasUnavailable"));
    const kept = detail.board.nodes.filter((node) => node.type !== "group" || !node.data.pixelStyle || node.id === group.id);

    const workflow = createCategoryWorkflow(category, level, imageModels, group.id);
    const nodeId = workflow.outputNodeId;
    const workflowNodes = expandCanvasGroups([...kept, ...workflow.nodes]);
    const firstGroup = workflowNodes.find((node) => node.id === group.id)!;
    const presetIds = pixelAssetTemplatePresetIds(category);
    // The guide grows with its use list, so it sits a fixed gap above the groups instead of a fixed offset.
    const introduction: AssetCanvasNode = {
      id: crypto.randomUUID(),
      type: "text",
      title: t("assetCanvas.pixelPresets.introductionTitle", { category: t(`assetCanvas.pixelPresets.categories.${category}`) }),
      position: { x: firstGroup.position.x, y: firstGroup.position.y - GUIDE_BASE_HEIGHT - presetIds.length * GUIDE_ROW_HEIGHT - STEP_GAP },
      width: GUIDE_WIDTH,
      data: {
        instruction: `pixel-asset-template:${category}`,
        text: [
          t(`assetCanvas.pixelPresets.templateDescriptions.${category}`),
          t("assetCanvas.pixelPresets.introduction"),
          ...presetIds.map((id) => `${pixelAssetPresetLabel(id)}: ${pixelAssetPresetUsage(id)}`),
        ].join("\n\n"),
      },
    };
    let nodes: AssetCanvasNode[] = [introduction, ...workflowNodes];
    if (category === "animation") {
      // Steps 1-3 run down one column: guide above the groups, then splitting, merging, and the GIF examples below.
      const maxGroupBottom = firstGroup.position.y + (firstGroup.height ?? 560);
      const step = (index: 2 | 3, y: number): AssetCanvasNode => ({
        id: crypto.randomUUID(),
        type: "text",
        title: t(`assetCanvas.pixelPresets.animationStep${index}Title`),
        position: { x: firstGroup.position.x, y },
        width: GUIDE_WIDTH,
        data: { instruction: PIXEL_ASSET_TEMPLATE_NOTE, text: t(`assetCanvas.pixelPresets.animationStep${index}Body`) },
      });
      const step2 = step(2, maxGroupBottom + STEP_GAP);
      const step3 = step(3, step2.position.y + STEP_HEIGHT + STEP_GAP);
      introduction.title = t("assetCanvas.pixelPresets.animationStep1Title");

      const gifGroupY = step3.position.y + STEP_HEIGHT + STEP_GAP;
      const GIF_NODE_COL_GAP = 460;
      const GIF_NODE_ROW_GAP = 420;
      const GIF_NODE_START_X = 16;
      const GIF_NODE_START_Y = 52;

      const gifGroupNodes: AssetCanvasNode[] = (() => {
        const gifGroupId = crypto.randomUUID();

        const gifExamples = pixelAssetTemplatePresetIds(category).flatMap((presetId) => {
          const exampleImage = pixelPresetGifExampleId(presetId, level);
          return exampleImage ? [{ presetId, exampleImage }] : [];
        });
        const gifChildNodes: AssetCanvasNode[] = gifExamples.map(({ presetId, exampleImage }, index) => {
          return {
            id: crypto.randomUUID(),
            type: "image" as const,
            parentId: gifGroupId,
            title: pixelAssetPresetLabel(presetId),
            position: {
              x: GIF_NODE_START_X + (index % 2) * GIF_NODE_COL_GAP,
              y: GIF_NODE_START_Y + Math.floor(index / 2) * GIF_NODE_ROW_GAP,
            },
            data: {
              prompt: "",
              resolution: "1K" as ImageResolution,
              aspectRatio: "1:1" as ImageAspectRatio,
              images: [],
              sourceInput: true as const,
              sourceInputLabel: pixelAssetPresetLabel(presetId),
              pixelStyle: level,
              exampleImage,
            },
          };
        });

        const gifGroup: AssetCanvasNode = {
          id: gifGroupId,
          type: "group" as const,
          position: { x: firstGroup.position.x, y: gifGroupY },
          data: {
            name: `${t(`assetCanvas.pixelPresets.levels.${level}`)} · GIF`,
          },
        };

        return [gifGroup, ...gifChildNodes];
      })();

      nodes = [introduction, step2, step3, ...workflowNodes, ...expandCanvasGroups(gifGroupNodes)];
    }
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
  reference.data.exampleImage = pixelTemplateReferenceExampleId(category, level);
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
