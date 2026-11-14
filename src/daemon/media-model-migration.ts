import type { CanvasBoard } from "../shared/canvas-workspace.js";
import {
  MINIMAX_RETIRED_RETRY,
  SEEDANCE_RETIRED_RETRY,
} from "../shared/media-migration-errors.js";
import type {
  AgentModelRef,
  RunToolRequest,
  ToolJob,
} from "../shared/contracts.js";
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

// compat: since beta.5.8, remove from beta.7 and 2026-12-14. Historical
// built-in tasks retain their owner; replay could submit another paid request.
type HistoricalMediaJob = Pick<ToolJob, "toolId" | "model"> & {
  input?: RunToolRequest;
};
export function retiredMediaRetry(
  job: HistoricalMediaJob,
  state: MediaMigrationState,
): string | undefined {
  const model =
    job.toolId === "generate-image"
      ? job.input && "imageModel" in job.input
        ? job.input.imageModel
        : job.model
      : job.input && "model" in job.input
        ? job.input.model
        : job.model;
  if (
    state.minimax &&
    job.toolId === "generate-video" &&
    (model?.provider === "minimax-video-cn" ||
      model?.provider === "minimax-video-global")
  )
    return MINIMAX_RETIRED_RETRY;
  if (
    state.seedance &&
    (job.toolId === "generate-image" || job.toolId === "generate-video") &&
    (model?.provider === "volcengine-ark" ||
      model?.provider === "byteplus-modelark")
  )
    return SEEDANCE_RETIRED_RETRY;
}

/** A read-only notice; preserve the original error and input in stored history. */
export function mediaJobNotice<
  T extends HistoricalMediaJob & Pick<ToolJob, "status">,
>(job: T, state: MediaMigrationState): T {
  const error = ["failed", "cancelled"].includes(job.status)
    ? retiredMediaRetry(job, state)
    : undefined;
  return error ? { ...job, error } : job;
}
