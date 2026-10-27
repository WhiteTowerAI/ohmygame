import {
  AUDIO_REFERENCE_ID_PATTERN,
  type AudioGenerationRequest,
  type AudioModel,
  type AudioModelCatalog,
  type GeneratedAudio,
  type AudioReferenceData,
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
  defaultVoiceId?(): string | undefined;
  configured(): boolean;
  enabled(): boolean;
  models(): AudioModel[];
  generate(
    input: AudioGenerationRequest,
    signal?: AbortSignal,
    references?: readonly AudioReferenceData[],
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
  constructor(private readonly adapters: readonly AudioProviderAdapter[], private readonly resolveReference?: (assetId: string) => Promise<{ bytes: Uint8Array; mediaType: string }>) {}

  catalog(): AudioModelCatalog {
    const providers = this.adapters.map((adapter) => {
      const configured = adapter.configured();
      const enabled = adapter.enabled();
      return {
        provider: adapter.id,
        name: adapter.name,
        ...(adapter.defaultVoiceId?.() ? { defaultVoiceId: adapter.defaultVoiceId() } : {}),
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
    if (input.operation === "music" && input.referenceAssetId && !input.references?.length) input = { ...input, references: [{ id: "Audio1", type: "audio", assetId: input.referenceAssetId }] };
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
    const references = "references" in input ? input.references ?? [] : [];
    // Counts and modes are provider limits; adapters check them against their capabilities.
    const alias = new RegExp(AUDIO_REFERENCE_ID_PATTERN);
    if (new Set(references.map((reference) => reference.id)).size !== references.length || references.some((reference) => !alias.test(reference.id) || !["image", "audio"].includes(reference.type))) throw new AudioGenerationError("Invalid audio reference aliases", 400);
    if (references.length && !this.resolveReference) throw new AudioGenerationError("Audio reference assets are unavailable", 400);
    const resolved = await Promise.all(references.map(async (reference) => ({ ...reference, ...await this.resolveReference!(reference.assetId) })));
    return adapter.generate(
      { ...input, model: { provider: model.provider, id: model.id } },
      signal,
      resolved,
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
