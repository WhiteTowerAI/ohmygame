import type { CanvasBoard } from "../shared/canvas-workspace.js";
import type { AgentModelRef } from "../shared/contracts.js";

/** Only the model identities supported by the reviewed MiniMax Beta adapter. */
export function migratedMinimaxModel<T extends AgentModelRef>(model: T): T {
  const provider =
    model.provider === "minimax-video-cn"
      ? "plugin.ohmygame.minimax.cn"
      : model.provider === "minimax-video-global"
        ? "plugin.ohmygame.minimax.global"
        : undefined;
  if (!provider || !["MiniMax-H3", "MiniMax-H3-Max"].includes(model.id))
    return model;
  return { ...model, provider };
}

export function migratedMinimaxBoard(board: CanvasBoard): CanvasBoard {
  let changed = false;
  const nodes = board.nodes.map((node) => {
    if (node.type !== "video" || !node.data.model) return node;
    const model = migratedMinimaxModel(node.data.model);
    if (model === node.data.model) return node;
    changed = true;
    return { ...node, data: { ...node.data, model } };
  });
  return changed ? { ...board, nodes } : board;
}
