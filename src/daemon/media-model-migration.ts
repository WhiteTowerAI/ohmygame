import type { CanvasBoard } from "../shared/canvas-workspace.js";
import type { AgentModelRef } from "../shared/contracts.js";
import { migratedMinimaxModel } from "./minimax-model-migration.js";
import { SEEDANCE_MIGRATION_REGIONS } from "./seedance-migration-settings.js";

export interface MediaMigrationState {
  minimax?: boolean;
  seedance?: boolean;
}

/** Map only reviewed identities of the selected media kind in committed profiles. */
export function migratedMediaModel<T extends AgentModelRef>(
  model: T,
  kind: "image" | "video",
  state: MediaMigrationState,
): T {
  if (kind === "video" && state.minimax) {
    const mapped = migratedMinimaxModel(model);
    if (mapped !== model) return mapped;
  }
  if (!state.seedance) return model;
  const region = SEEDANCE_MIGRATION_REGIONS.find(
    ({ source }) => source === model.provider,
  );
  if (!region) return model;
  const models: readonly string[] =
    kind === "image" ? region.imageModels : region.videoModels;
  return models.includes(model.id)
    ? { ...model, provider: region.target }
    : model;
}

/** Only future selections move; preserve outputs, jobs, references and raw board metadata. */
export function migratedMediaBoard(
  board: CanvasBoard,
  state: MediaMigrationState,
): CanvasBoard {
  let changed = false;
  const nodes = board.nodes.map((node) => {
    if ((node.type !== "image" && node.type !== "video") || !node.data.model)
      return node;
    const model = migratedMediaModel(node.data.model, node.type, state);
    if (model === node.data.model) return node;
    changed = true;
    return node.type === "image"
      ? { ...node, data: { ...node.data, model } }
      : { ...node, data: { ...node.data, model } };
  });
  return changed ? { ...board, nodes } : board;
}
