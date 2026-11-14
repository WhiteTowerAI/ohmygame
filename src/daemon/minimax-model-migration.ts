import { MINIMAX_RETIRED_RETRY } from "../shared/media-migration-errors.js";
import type { AgentModelRef, RunToolRequest, ToolJob } from "../shared/contracts.js";

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

/** An old built-in job has no durable vendor task ID; retry could pay twice. */

export function legacyMinimaxJob(job: Pick<ToolJob, "toolId" | "model"> & { input?: RunToolRequest }): boolean {
  const model = job.input && "model" in job.input ? job.input.model : job.model;
  return job.toolId === "generate-video" && (model?.provider === "minimax-video-cn" || model?.provider === "minimax-video-global");
}

/** A read-only notice; preserve the original provider error in stored history. */
export function minimaxJobNotice<T extends Pick<ToolJob, "toolId" | "model" | "status"> & { input?: RunToolRequest }>(job: T, retired: boolean): T {
  return retired && ["failed", "cancelled"].includes(job.status) && legacyMinimaxJob(job)
    ? { ...job, error: MINIMAX_RETIRED_RETRY }
    : job;
}
