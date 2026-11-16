import type { AudioKind, AudioModel } from "../shared/audio.js";
import type { ModelRef } from "../shared/contracts.js";

export function audioModelsForKind(models: readonly AudioModel[], kind?: AudioKind): AudioModel[] {
  const fitting = models.filter((model) => kind ? model.capabilities.produces.includes(kind) : model.capabilities.produces.length);
  return kind === "speech" ? [...fitting.filter((model) => model.capabilities.readsText), ...fitting.filter((model) => !model.capabilities.readsText)] : fitting;
}

/** Keep explicit defaults even when disconnected, so another account is never chosen silently. */
export function defaultAudioModelForKind(models: readonly AudioModel[], defaults: Partial<Record<AudioKind, ModelRef>> | undefined, kind?: AudioKind): ModelRef | undefined {
  const model = defaults?.[kind ?? "speech"] ?? audioModelsForKind(models, kind)[0];
  return model && { provider: model.provider, id: model.id };
}
