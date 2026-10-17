import type {
  AudioGenerationRequest,
  AudioModel,
  AudioModelCatalog,
  GeneratedAudio,
} from "../shared/audio.js";
import type { ModelRef } from "../shared/contracts.js";

export class AudioGenerationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface AudioProviderAdapter {
  readonly id: string;
  readonly name: string;
  configured(): boolean;
  enabled(): boolean;
  models(): AudioModel[];
  generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
}

export interface AudioGenerator {
  catalog(): Promise<AudioModelCatalog> | AudioModelCatalog;
  generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio>;
}

export class ProviderAudio implements AudioGenerator {
  constructor(private readonly adapters: readonly AudioProviderAdapter[]) {}

  catalog(): AudioModelCatalog {
    const providers = this.adapters.map((adapter) => {
      const configured = adapter.configured();
      const enabled = adapter.enabled();
      return {
        provider: adapter.id,
        name: adapter.name,
        configured,
        state: !enabled
          ? ("disabled" as const)
          : configured
            ? ("ready" as const)
            : ("not_configured" as const),
        ...(!configured
          ? { message: `Connect ${adapter.name} before generating audio.` }
          : {}),
      };
    });
    return {
      models: this.adapters
        .filter((adapter) => adapter.configured() && adapter.enabled())
        .flatMap((adapter) => adapter.models()),
      providers,
    };
  }

  resolveModel(
    operation: AudioGenerationRequest["operation"],
    requested?: ModelRef,
  ): AudioModel | undefined {
    const catalog = this.catalog().models.filter((model) =>
      model.capabilities.operations.includes(operation),
    );
    return requested
      ? catalog.find((model) => sameModel(model, requested))
      : catalog[0];
  }

  async generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
  ): Promise<GeneratedAudio> {
    const model = this.resolveModel(input.operation, input.model);
    if (!model) {
      if (input.model)
        throw new AudioGenerationError(
          "The selected audio model is unavailable or does not support this operation",
          400,
        );
      throw new AudioGenerationError(
        `No ${operationName(input.operation)} model is available. Connect an audio provider first.`,
        503,
      );
    }
    const adapter = this.adapters.find(
      (candidate) => candidate.id === model.provider,
    );
    if (!adapter)
      throw new AudioGenerationError(
        "The selected audio provider is unavailable",
        503,
      );
    return adapter.generate(
      { ...input, model: { provider: model.provider, id: model.id } },
      signal,
    );
  }
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.provider === right.provider && left.id === right.id;
}

function operationName(operation: AudioGenerationRequest["operation"]): string {
  if (operation === "sound-effect") return "sound effect";
  return operation;
}
