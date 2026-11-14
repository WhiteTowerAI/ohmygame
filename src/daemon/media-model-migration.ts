import type { CanvasBoard } from "../shared/canvas-workspace.js";
import {
  MINIMAX_RETIRED_RETRY,
  SEEDANCE_RETIRED_RETRY,
} from "../shared/media-migration-errors.js";
import type {
  AgentModelRef,
  Model3DOperation,
  RunToolRequest,
  ToolJob,
} from "../shared/contracts.js";
import { migratedMinimaxModel } from "./minimax-model-migration.js";
import { SEEDANCE_MIGRATION_REGIONS } from "./seedance-migration-settings.js";
import type { Native3DProviderId } from "../shared/model3d-presets.js";

/** Reviewed identities from a committed settings migration, including custom versions. */
export interface Model3DReferenceMigration {
  source: Native3DProviderId;
  target: string;
  models: readonly { id: string; operations: readonly Model3DOperation[] }[];
  processing?: { id: string; operations: readonly Model3DOperation[] };
}

export interface MediaMigrationState {
  minimax?: boolean;
  seedance?: boolean;
  model3D?: readonly Model3DReferenceMigration[];
}

/** Map only reviewed identities of the selected media kind in committed profiles. */
export function migratedMediaModel<T extends AgentModelRef>(
  model: T,
  kind: "image" | "video" | "3d",
  state: MediaMigrationState,
): T {
  if (kind === "3d") return migratedModel3DReference(model, state);
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

/** A future selection, including the historical default animation connection. Never use on paid job inputs. */
export function migratedModel3DSelection(
  model: AgentModelRef | undefined,
  operation: Model3DOperation,
  state: MediaMigrationState,
): AgentModelRef | undefined {
  if (model) return migratedModel3DReference(model, state, operation);
  if (operation !== "animate") return undefined;
  const mapping = state.model3D?.find(
    ({ source, processing }) => source === "meshy" && processing?.operations.includes("animate"),
  );
  return mapping ? { provider: mapping.target, id: mapping.processing!.id } : undefined;
}

// compat: since beta.5.8, remove from beta.7 and 2026-12-15. Only future
// selections move after settings commit; native paid task inputs keep their owner.
function migratedModel3DReference<T extends AgentModelRef>(
  model: T,
  state: MediaMigrationState,
  operation?: Model3DOperation,
): T {
  const mapping = state.model3D?.find(
    ({ source }) => source === model.provider,
  );
  if (!mapping) return model;
  if (
    operation === "remesh" ||
    operation === "retexture" ||
    operation === "animate"
  ) {
    // Native processing already resolves old geometry IDs to its connection.
    const processing = mapping.processing;
    return processing?.operations.includes(operation)
      ? { ...model, provider: mapping.target, id: processing.id }
      : model;
  }
  const supported = mapping.models.some(
    ({ id, operations }) =>
      id === model.id &&
      (operation
        ? operations.includes(operation)
        : operations.some((value) => value === "image" || value === "text")),
  );
  return supported ? { ...model, provider: mapping.target } : model;
}

/** Only future selections move; preserve outputs, jobs, references and raw board metadata. */
export function migratedMediaBoard(
  board: CanvasBoard,
  state: MediaMigrationState,
): CanvasBoard {
  let changed = false;
  const nodes = board.nodes.map((node) => {
    if (node.type === "model-3d" || node.type === "animate-3d") {
      const operation =
        node.type === "animate-3d"
          ? "animate"
          : (node.data.operation ?? "image");
      const model = migratedModel3DSelection(node.data.model, operation, state);
      if (model === node.data.model) return node;
      changed = true;
      return node.type === "model-3d"
        ? { ...node, data: { ...node.data, model } }
        : { ...node, data: { ...node.data, model } };
    }
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
