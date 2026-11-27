import { migratedAudioSelection, migratedModel3DSelection, type MediaMigrationState } from "./media-model-migration.js";
import { AUDIO_SETTING_KEYS, audioExtension, audioCompanionFiles } from "../shared/audio.js";
import { migrateLegacyAudioJob } from "../shared/audio-legacy.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MAX_REFERENCE_IMAGES,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  TOOL_IDS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type ModelRef,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
  type PromptImage,
  type VideoAspectRatio,
  type VideoGenerationReference,
  type VideoResolution,
  type ImageSize,
  type RunImageToolRequest,
  type RunBackgroundRemovalRequest,
  type Run3DToolRequest,
  type RunAnimate3DToolRequest,
  type RunVideoToolRequest,
  type RunToolRequest,
  type ToolId,
  type ToolRun,
  type ToolRunFile,
  type Model3DMetadata,
} from "../shared/contracts.js";
import { ImageGenerationError, type ImageGenerator, type ImageGenerationRecovery, type GeneratedImage } from "./openai-image.js";
import { sniffImageType } from "./image-format.js";
import { BACKGROUND_IMAGE_MAX_BYTES } from "./image-background.js";
import { Model3DGenerationError, type Generated3DModel, type Model3DAnimationAction, type Model3DGenerator } from "./model3d.js";
import { mediaTaskJournal, type MediaTaskJournal } from "./media-task-journal.js";
import { model3DJournal } from "./model3d-journal.js";
import type { NativeModel3DRecovery } from "./model3d-native-recovery.js";
import { inspectModel3D } from "./model3d-inspect.js";
import type { Model3DExecution } from "./model3d.js";
import { MAX_ANIMATION_ACTIONS, resolveModel3D } from "../shared/generation-config.js";
import { remeshPolycountFor } from "../shared/model3d-operations.js";
import { VideoGenerationError, type VideoGenerator, type VideoReferenceAsset } from "./video-generation.js";
import { isImageHookRecords } from "../shared/plugin-hooks.js";
import { AudioGenerationError, type AudioGenerator } from "./audio-generation.js";
import type { AudioGenerationRequest } from "../shared/audio.js";

const VIDEO_DEFAULT_DURATION = 6;

interface StoredToolRun extends ToolRun {
  version: 1;
  preview?: { fileName: string; mediaType: "image/png" | "image/jpeg" };
}

/** A media file in a project that a generation reads. */
export interface ToolMediaFile {
  name: string;
  absolutePath: string;
  mediaType: "image" | "video" | "audio" | "model";
  contentType: string;
  size: number;
  model3d?: Model3DMetadata;
}

/** Finds `filePath` in the project, or throws why it can't be read. */
export type ToolMediaFiles = (projectId: string, filePath: string) => Promise<ToolMediaFile>;

export class ToolRunError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export class ToolRunner {
  readonly #runsDirectory: string;
  #log?: GenerationLogger;

  constructor(
    dataDirectory: string,
    private readonly imageGenerator: ImageGenerator,
    private readonly model3DGenerator?: Model3DGenerator,
    private readonly videoGenerator?: VideoGenerator,
    private readonly media?: ToolMediaFiles,
    private readonly resolveInput?: (toolId: string, input: RunToolRequest, projectId?: string) => Promise<RunToolRequest>,
    private readonly audioGenerator?: AudioGenerator,
    private readonly mediaMigrations: MediaMigrationState = {},
    private readonly model3DRecovery?: Pick<NativeModel3DRecovery, "forTask">,
  ) {
    this.#runsDirectory = path.join(dataDirectory, "tools", "runs");
  }

  /**
   * Lets the project's plugins change an image's prompt and parameters
   * before it is generated, and before its model is resolved.
   */
  #beforeImage?: (input: RunImageToolRequest, projectId: string) => Promise<RunImageToolRequest>;

  setImageHook(hook: (input: RunImageToolRequest, projectId: string) => Promise<RunImageToolRequest>): void {
    this.#beforeImage = hook;
  }

  /** Where finished generations are logged; the daemon passes its logger. */
  setLogger(log: GenerationLogger): void {
    this.#log = log;
  }

  async load(): Promise<void> {
    await mkdir(this.#runsDirectory, { recursive: true });
  }

  async backgroundRemovalModels() {
    return await this.imageGenerator.backgroundRemovalModels?.() ?? [];
  }

  async animationActions(model?: ModelRef, options?: RunAnimate3DToolRequest["options"]): Promise<Model3DAnimationAction[]> {
    const generator = this.model3DGenerator;
    if (!generator?.animations) throw new ToolRunError("3D animation is not configured", 503);
    try { return await generator.animations(undefined, migratedModel3DSelection(model, "animate", this.mediaMigrations), options); }
    catch (cause) { throw cause instanceof Model3DGenerationError ? new ToolRunError(cause.message, cause.statusCode) : cause; }
  }

  /** `projectId`: the project whose files the input names, as a model to retexture or a video's references. */
  async run(toolId: string, input: RunToolRequest, signal?: AbortSignal, projectId?: string): Promise<ToolRun> {
    let prepared = input;
    return this.#withGenerationLog(toolId, () => prepared, signal, projectId, async () => {
      prepared = await this.#prepare(toolId, input, projectId);
      return this.#runPrepared(toolId, prepared, signal, randomUUID(), projectId);
    });
  }

  /** `hooksApplied`: the input was prepared before (a retry), so plugins' changes and their records are kept as they are. */
  async prepare(toolId: string, input: RunToolRequest, projectId?: string, options: { hooksApplied?: boolean } = {}): Promise<RunToolRequest> {
    const started = Date.now();
    try {
      return await this.#prepare(toolId, input, projectId, options.hooksApplied);
    } catch (cause) {
      this.#recordGeneration(toolId, () => input, projectId, started, "failed", cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  async #prepare(toolId: string, input: RunToolRequest, projectId?: string, hooksApplied = false): Promise<RunToolRequest> {
    if (!isToolId(toolId)) throw new ToolRunError("Tool not found", 404);
    if (toolId === "generate-image" && hooksApplied) {
      // Keep the first run's record only when it is well formed.
      const { requestedPrompt, pluginChanges, ...rest } = input as RunImageToolRequest;
      if (typeof requestedPrompt !== "string" || !isImageHookRecords(pluginChanges)) input = rest as RunImageToolRequest;
    } else if (toolId === "generate-image") {
      // Only the app records what plugins changed.
      const { requestedPrompt: _, pluginChanges: __, ...asked } = input as RunImageToolRequest;
      input = projectId && this.#beforeImage ? await this.#beforeImage(asked as RunImageToolRequest, projectId) : asked as RunImageToolRequest;
    }
    if (!hooksApplied && toolId === "generate-audio" && input && typeof input === "object" && !Array.isArray(input)) {
      const value = input as AudioGenerationRequest;
      const model = migratedAudioSelection(value.model, value.kind, this.mediaMigrations);
      if (model !== value.model) input = { ...value, model };
    }
    const resolved = this.resolveInput ? await this.resolveInput(toolId, input, projectId) : input;
    if (!hooksApplied && (toolId === "image-to-3d" || toolId === "animate-3d")) {
      const value = resolved as Run3DToolRequest | RunAnimate3DToolRequest;
      const operation = toolId === "animate-3d" ? "animate" : (value as Run3DToolRequest).operation ?? "image";
      const model = migratedModel3DSelection(value.model, operation, this.mediaMigrations);
      if (model !== value.model) return { ...value, model };
    }
    return resolved;
  }

  /** Executes an input whose model and generation options have already been resolved. */
  async runPrepared(toolId: string, input: RunToolRequest, signal?: AbortSignal, options: { recoveryId?: string; projectId?: string } = {}): Promise<ToolRun> {
    const { recoveryId = randomUUID(), projectId } = options;
    return this.#withGenerationLog(toolId, () => input, signal, projectId, () => this.#runPrepared(toolId, input, signal, recoveryId, projectId));
  }

  async #withGenerationLog(toolId: string, input: () => RunToolRequest, signal: AbortSignal | undefined, projectId: string | undefined, execute: () => Promise<ToolRun>): Promise<ToolRun> {
    const started = Date.now();
    let status: "succeeded" | "failed" | "cancelled" = "succeeded";
    let error: string | undefined;
    let run: ToolRun | undefined;
    try {
      run = await execute();
      return run;
    } catch (cause) {
      status = signal?.aborted || cause instanceof Error && cause.name === "AbortError" ? "cancelled" : "failed";
      error = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    } finally {
      this.#recordGeneration(toolId, input, projectId, started, status, error, run?.model);
    }
  }

  #recordGeneration(toolId: string, input: () => RunToolRequest, projectId: string | undefined, started: number, status: "succeeded" | "failed" | "cancelled", error?: string, runModel?: ModelRef): void {
    try {
      const model = runModel ?? selectedModel(toolId, input());
      const outcome = {
        toolId,
        ...(model ? { model: `${model.provider}/${model.id}` } : {}),
        ...(projectId ? { projectId } : {}),
        durationMs: Date.now() - started,
      };
      if (status === "failed") this.#log?.warn({ ...outcome, error }, "Generation failed");
      else this.#log?.info(outcome, status === "cancelled" ? "Generation cancelled" : "Generation succeeded");
    } catch { /* Logging must not change the result or prevent job persistence. */ }
  }

  async #runPrepared(toolId: string, input: RunToolRequest, signal: AbortSignal | undefined, recoveryId: string, projectId?: string): Promise<ToolRun> {
    if (toolId === "image-to-3d") {
      assertOnlyKeys(input, ["images", "model", "targetPolycount", "texture", "pbr", "operation", "prompt", "sourcePath", "options"]);
      return this.#run3D(input as Run3DToolRequest, projectId, signal, await model3DJournal(path.join(this.#runsDirectory, "../model3d-tasks"), recoveryId),
        await mediaTaskJournal(path.join(this.#runsDirectory, "../media-tasks"), recoveryId), recoveryId).catch(model3DToolError);
    }
    if (toolId === "animate-3d") {
      assertOnlyKeys(input, ["path", "actionIds", "heightMeters", "model", "options"]);
      return this.#runAnimate3D(input as RunAnimate3DToolRequest, projectId, signal, await model3DJournal(path.join(this.#runsDirectory, "../model3d-tasks"), recoveryId),
        await mediaTaskJournal(path.join(this.#runsDirectory, "../media-tasks"), recoveryId), recoveryId).catch(model3DToolError);
    }
    if (toolId === "generate-video") {
      assertOnlyKeys(input, ["prompt", "model", "references", "duration", "aspectRatio", "resolution", "referenceMode"]);
      return this.#runVideo(input as RunVideoToolRequest, projectId, signal, recoveryId);
    }
    if (toolId === "generate-audio") {
      assertOnlyKeys(input, ["prompt", "model", "kind", "durationSeconds", "loop", "instrumental", ...AUDIO_SETTING_KEYS]);
      return this.#runAudio(input as AudioGenerationRequest, signal, await mediaTaskJournal(path.join(this.#runsDirectory, "../media-tasks"), recoveryId));
    }
    if (toolId === "remove-image-background") {
      assertOnlyKeys(input, ["image", "model"]);
      return this.#runBackgroundRemoval(input as RunBackgroundRemovalRequest, signal, await mediaTaskJournal(path.join(this.#runsDirectory, "../media-tasks"), recoveryId));
    }
    if (toolId !== "generate-image") throw new ToolRunError("Tool not found", 404);
    assertOnlyKeys(input, ["prompt", "imageModel", "params", "transparentBackground", "size", "resolution", "aspectRatio", "outputs", "images", "requestedPrompt", "pluginChanges"]);
    return this.#runImage(input as RunImageToolRequest, signal, {
      journal: await mediaTaskJournal(path.join(this.#runsDirectory, "../media-tasks"), recoveryId),
    });
  }

  async #runImage(input: RunImageToolRequest, signal: AbortSignal | undefined, recovery: ImageGenerationRecovery): Promise<ToolRun> {
    const prompt = input.prompt?.trim() ?? "";
    const imageInput = "images" in input ? input.images : undefined;
    if (!prompt && !imageInput?.length) throw new ToolRunError("Prompt or reference image is required", 400);
    const usesConfiguredOptions = input.resolution !== undefined || input.aspectRatio !== undefined || input.outputs !== undefined || imageInput !== undefined;
    if (input.size !== undefined && usesConfiguredOptions) throw new ToolRunError("Image size cannot be combined with resolution, aspect ratio, output count, or reference images", 400);
    if (usesConfiguredOptions && (input.resolution === undefined || input.aspectRatio === undefined)) {
      throw new ToolRunError("Resolution and aspect ratio are required for configured image generation", 400);
    }
    const size = input.size ?? "1024x1024";
    if (!isImageSize(size)) throw new ToolRunError("Unsupported image size", 400);
    const resolution = input.resolution;
    const aspectRatio = input.aspectRatio;
    const outputs = input.outputs ?? 1;
    if (resolution !== undefined && !isImageResolution(resolution)) throw new ToolRunError("Unsupported image resolution", 400);
    if (aspectRatio !== undefined && !isImageAspectRatio(aspectRatio)) throw new ToolRunError("Unsupported image aspect ratio", 400);
    if (!isImageOutputCount(outputs)) throw new ToolRunError("Unsupported image output count", 400);
    if (imageInput && (imageInput.length > IMAGE_MAX_REFERENCE_IMAGES || imageInput.some((image) => !isPromptImage(image, true)))) throw new ToolRunError(`Up to ${IMAGE_MAX_REFERENCE_IMAGES} PNG, JPEG, or WebP images are supported`, 400);
    const params = input.params;
    if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params) || Object.values(params).some((value) => !["string", "number", "boolean"].includes(typeof value))))
      throw new ToolRunError("params must be an object of text, number or true/false values", 400);

    const changed = input.pluginChanges?.length && input.requestedPrompt !== undefined
      ? { requestedPrompt: input.requestedPrompt, pluginChanges: input.pluginChanges }
      : {};
    return this.#storeImageRun("generate-image", input.imageModel, prompt, changed, signal, () => Promise.all(Array.from({ length: outputs }, () => this.imageGenerator.generate({
        prompt,
        ...(input.imageModel ? { imageModel: input.imageModel } : {}),
        ...(params && Object.keys(params).length ? { params } : {}),
        ...(input.transparentBackground ? { transparentBackground: true } : {}),
        ...(usesConfiguredOptions ? { resolution: resolution!, aspectRatio: aspectRatio!, ...(imageInput?.length ? { images: imageInput } : {}) } : { size }),
      }, signal, { ...recovery, outputs }))));
  }

  async #runBackgroundRemoval(input: RunBackgroundRemovalRequest, signal: AbortSignal | undefined, journal: MediaTaskJournal): Promise<ToolRun> {
    if (!isPromptImage(input.image, true) || input.image.data.length > Math.ceil(BACKGROUND_IMAGE_MAX_BYTES / 3) * 4)
      throw new ToolRunError("Choose one PNG, JPEG or WebP image of at most 20 MB", 400);
    if (!input.model || typeof input.model.provider !== "string" || typeof input.model.id !== "string" || !input.model.provider || !input.model.id)
      throw new ToolRunError("Choose a background removal model", 400);
    if (!this.imageGenerator.removeBackground) throw new ToolRunError("Background removal is unavailable", 503);
    // Retain the small paid-task receipt: canvas import or job persistence may still fail after tool storage.
    return this.#storeImageRun("remove-image-background", input.model, "Remove background", {}, signal,
      async () => [await this.imageGenerator.removeBackground!(input.model, Buffer.from(input.image.data, "base64"), signal, journal)]);
  }

  async #storeImageRun(toolId: "generate-image" | "remove-image-background", model: ModelRef | undefined, prompt: string,
    changed: Pick<RunImageToolRequest, "requestedPrompt" | "pluginChanges">, signal: AbortSignal | undefined,
    generate: () => Promise<GeneratedImage[]>): Promise<ToolRun> {
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const generated = await generate();
      signal?.throwIfAborted();
      const files: ToolRunFile[] = generated.map((image, index) => {
        // Providers and proxies can ignore the requested output format.
        const mediaType = sniffImageType(image.bytes) ?? image.mediaType;
        const name = imageFileName(mediaType, generated.length > 1 ? index + 1 : undefined);
        return { name, mediaType, title: mediaName(prompt, name) };
      });
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId,
        ...(model ? { model } : {}),
        createdAt: new Date().toISOString(),
        files,
        // The prompt is kept only when plugins changed it, so the agent hears what was generated.
        ...("pluginChanges" in changed ? { prompt, ...changed } : {}),
      };
      await mkdir(temporary, { recursive: true });
      await Promise.all(generated.map((image, index) => writeFile(path.join(temporary, files[index]!.name), image.bytes)));
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof ImageGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  /** `journal` keeps a plugin provider's task until the model is stored, as for video. */
  async #run3D(input: Run3DToolRequest, projectId: string | undefined, signal: AbortSignal | undefined, execution: Model3DExecution, journal: MediaTaskJournal, recoveryId: string): Promise<ToolRun> {
    const operation = input.operation ?? "image", images = input.images;
    if (!["image", "text", "retexture", "remesh"].includes(operation)) throw new ToolRunError("Unknown 3D operation", 400);
    if (input.prompt !== undefined && typeof input.prompt !== "string") throw new ToolRunError("3D prompt must be a string", 400);
    validate3DOptions(input.options);
    const generator = await this.model3DRecovery?.forTask(input.model, operation, recoveryId) ?? this.model3DGenerator;
    const model = generator?.resolveOperationModel ? await generator.resolveOperationModel(input.model, operation)
      : generator?.resolveModel ? await generator.resolveModel(input.model) : resolveModel3D(input.model);
    if (!model) throw new ToolRunError("The selected model does not support this 3D operation", 400);
    if (!Array.isArray(images) || images.some((image) => !isPromptImage(image)) || images.length > (operation === "retexture" ? 1 : model.maxReferenceImages)) throw new ToolRunError("Invalid 3D reference images", 400);
    if (operation === "image" && input.prompt?.trim()) throw new ToolRunError("Use text generation for a prompt", 400);
    if (operation === "image" && !images.length) throw new ToolRunError("Provide at least one reference image", 400);
    if (operation === "text" && (!input.prompt?.trim() || images.length)) throw new ToolRunError("Text-to-3D needs a prompt without images", 400);
    if (operation === "retexture" && !input.prompt?.trim() && !images.length) throw new ToolRunError("Add a texture prompt or reference image", 400);
    if (operation === "remesh" && (images.length || input.prompt?.trim())) throw new ToolRunError("Remesh takes a model and face count only", 400);
    const range = operation === "remesh" ? remeshPolycountFor(model) : model.polycount;
    if (operation !== "retexture" && input.targetPolycount !== undefined && (!Number.isInteger(input.targetPolycount) || input.targetPolycount < range.min || input.targetPolycount > range.max)) throw new ToolRunError(`3D poly count must be between ${range.min} and ${range.max}`, 400);
    if (input.texture !== undefined && typeof input.texture !== "boolean" || input.pbr !== undefined && typeof input.pbr !== "boolean") throw new ToolRunError("Texture and PBR must be booleans", 400);
    if (!generator) throw new ToolRunError("3D generation is not configured", 503);
    validateOperationOptions(input.options, operation, model.protocol);
    let source: Buffer | undefined, sourceMetadata: Generated3DModel["metadata"];
    if (operation === "retexture" || operation === "remesh") {
      const content = await this.#modelSource(projectId, input.sourcePath);
      source = content.bytes; sourceMetadata = content.metadata;
    } else if (input.sourcePath !== undefined) throw new ToolRunError("Generation does not accept a source model", 400);
    const primaryImage = images[0];
    const run = await this.#storeModelRun("image-to-3d", signal, async () => {
      const { sourcePath: _, ...generationInput } = input;
      const result = await generator.generate({ ...generationInput, model: { provider: model.provider, id: model.id }, source, execution, journal }, signal);
      return { ...result, metadata: { ...(sourceMetadata?.forwardAxis ? { forwardAxis: sourceMetadata.forwardAxis } : {}), ...result.metadata, provider: model.provider, operation } };
    }, primaryImage ? {
      fileName: `preview.${primaryImage.mediaType === "image/png" ? "png" : "jpg"}`,
      mediaType: primaryImage.mediaType as "image/png" | "image/jpeg", bytes: Buffer.from(primaryImage.data, "base64"),
    } : undefined, { provider: model.provider, id: model.id });
    // Stored: there's nothing left for a retry to fetch.
    await journal.clear().catch(() => undefined);
    return run;
  }

  async #modelSource(projectId: string | undefined, sourcePath?: string) {
    if (!sourcePath) throw new ToolRunError("Choose a source GLB model", 400);
    const source = await this.#mediaFile(projectId, sourcePath);
    if (source.contentType !== "model/gltf-binary") throw new ToolRunError("Only GLB models are supported", 400);
    const bytes = await readFile(source.absolutePath);
    const metadata = { ...source.model3d, ...await inspectModel3D(bytes) };
    return { bytes, metadata };
  }

  async #mediaFile(projectId: string | undefined, filePath: string): Promise<ToolMediaFile> {
    if (!projectId || !this.media) throw new ToolRunError("Choose a file in the project", 400);
    try {
      return await this.media(projectId, filePath);
    } catch (cause) {
      throw new ToolRunError(cause instanceof Error ? cause.message : String(cause), 404);
    }
  }

  async #runAnimate3D(input: RunAnimate3DToolRequest, projectId: string | undefined, signal: AbortSignal | undefined, execution: Model3DExecution, journal: MediaTaskJournal, recoveryId: string): Promise<ToolRun> {
    const { actionIds, heightMeters } = input;
    if (typeof input.path !== "string" || !input.path) throw new ToolRunError("Choose a 3D model to animate", 400);
    if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > MAX_ANIMATION_ACTIONS
      || actionIds.some((id) => typeof id === "number" ? !Number.isInteger(id) || id < 0 : typeof id !== "string" || !id || id.length > 120) || new Set(actionIds).size !== actionIds.length) {
      throw new ToolRunError(`Choose 1 to ${MAX_ANIMATION_ACTIONS} different animations`, 400);
    }
    if (heightMeters !== undefined && (typeof heightMeters !== "number" || !Number.isFinite(heightMeters) || heightMeters <= 0 || heightMeters > 100)) {
      throw new ToolRunError("Character height must be a positive number of meters", 400);
    }
    validate3DOptions(input.options);
    const generator = await this.model3DRecovery?.forTask(input.model, "animate", recoveryId) ?? this.model3DGenerator;
    if (!generator?.animate) throw new ToolRunError("3D animation is not configured", 503);
    const source = await this.#modelSource(projectId, input.path);
    const connection = generator.resolveOperationModel ? await generator.resolveOperationModel(input.model, "animate") : undefined;
    if (generator.resolveOperationModel && !connection) throw new ToolRunError("Choose an available animation provider", 400);
    validateOperationOptions(input.options, "animate", connection?.protocol ?? "meshy");
    if ((!connection || connection.protocol === "meshy") && (!source.metadata.textured || source.metadata.triangles > 300_000)) throw new ToolRunError("Meshy rigging requires a textured model with at most 300000 triangles. Retexture or remesh the model first.", 400);
    const run = await this.#storeModelRun("animate-3d", signal, async () => {
      const result = await generator.animate!({ model: source.bytes, actionIds, providerModel: input.model, options: input.options, forwardAxis: source.metadata.forwardAxis, execution, journal, ...(heightMeters !== undefined ? { heightMeters } : {}) }, signal);
      return { ...result, metadata: { ...(source.metadata.forwardAxis ? { forwardAxis: source.metadata.forwardAxis } : {}), ...result.metadata, provider: connection?.provider ?? input.model?.provider ?? "meshy", operation: "animate" } };
    }, undefined, input.model);
    await journal.clear().catch(() => undefined);
    return run;
  }

  /** Saves a generated GLB as a run, leaving nothing behind if anything fails part way. */
  async #storeModelRun(
    toolId: "image-to-3d" | "animate-3d",
    signal: AbortSignal | undefined,
    produce: () => Promise<Generated3DModel>,
    preview?: { fileName: string; mediaType: "image/png" | "image/jpeg"; bytes: Buffer },
    model?: ModelRef,
  ): Promise<ToolRun> {
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const generated = await produce();
      const model3d = { ...generated.metadata, ...await inspectModel3D(generated.bytes) };
      signal?.throwIfAborted();
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId,
        ...(model ? { model } : {}),
        createdAt: new Date().toISOString(),
        files: [{
          name: "model.glb",
          mediaType: generated.mediaType,
          model3d,
        }],
        ...(preview ? { preview: { fileName: preview.fileName, mediaType: preview.mediaType } } : {}),
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "model.glb"), generated.bytes);
      if (preview) await writeFile(path.join(temporary, preview.fileName), preview.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof Model3DGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #runVideo(input: RunVideoToolRequest, projectId: string | undefined, signal: AbortSignal | undefined, recoveryId: string): Promise<ToolRun> {
    if (!this.videoGenerator) throw new ToolRunError("Video generation is not configured", 503);
    const prompt = input.prompt?.trim();
    if (!prompt) throw new ToolRunError("Prompt must not be empty", 400);
    const references = input.references ?? [];
    validateVideoReferences(references);
    if (input.referenceMode !== undefined && input.referenceMode !== "frame" && input.referenceMode !== "reference") throw new ToolRunError("Unsupported video reference mode", 400);
    const duration = input.duration ?? VIDEO_DEFAULT_DURATION;
    if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new ToolRunError("Unsupported video duration", 400);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    let journal: MediaTaskJournal | undefined;
    try {
      signal?.throwIfAborted();
      const model = input.model;
      const aspectRatio = input.aspectRatio ?? "adaptive";
      const resolution = input.resolution ?? "720p";
      if (!model || !model.provider.trim() || !model.id.trim() || model.provider.length > 100 || model.id.length > 200) throw new ToolRunError("A valid video model is required", 400);
      if (!VIDEO_ASPECT_RATIOS.includes(aspectRatio as VideoAspectRatio)) throw new ToolRunError("Unsupported video aspect ratio", 400);
      if (!VIDEO_RESOLUTIONS.includes(resolution as VideoResolution)) throw new ToolRunError("Unsupported video resolution", 400);
      const resolvedReferences = await this.#videoReferences(projectId, references);
      journal = await mediaTaskJournal(path.join(this.#runsDirectory, "../media-tasks"), recoveryId);
      const generated = await this.videoGenerator.generate({ prompt, model, references: resolvedReferences, duration, aspectRatio, resolution, ...(input.referenceMode ? { referenceMode: input.referenceMode } : {}) }, signal, { journal });
      signal?.throwIfAborted();
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId: "generate-video",
        model,
        createdAt: new Date().toISOString(),
        files: [{
          name: "output.mp4",
          mediaType: generated.mediaType,
          title: mediaName(prompt, "output.mp4"),
        }],
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, "output.mp4"), generated.bytes);
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      // Stored: there's nothing left for a retry to fetch.
      await journal.clear().catch(() => undefined);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof VideoGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  /** `journal` keeps a plugin provider's paid result until the audio is stored, as for video. */
  async #runAudio(input: AudioGenerationRequest, signal: AbortSignal | undefined, journal: MediaTaskJournal): Promise<ToolRun> {
    const toolId = "generate-audio";
    if (!this.audioGenerator) throw new ToolRunError("Audio generation is not configured", 503);
    const id = randomUUID();
    const temporary = path.join(this.#runsDirectory, `.${id}.tmp`);
    const destination = path.join(this.#runsDirectory, id);
    try {
      signal?.throwIfAborted();
      const generated = await this.audioGenerator.generate(input, signal, journal);
      signal?.throwIfAborted();
      const extension = audioExtension(generated.mediaType);
      const fileName = `output.${extension}`;
      const prompt = input.prompt.trim();
      const audio = { ...(generated.metadata ? { metadata: generated.metadata } : {}), request: input };
      const companions = audioCompanionFiles(fileName, audio);
      const run: StoredToolRun = {
        version: 1,
        id,
        toolId,
        model: generated.model,
        createdAt: new Date().toISOString(),
        files: [{
          name: fileName,
          role: "audio",
          mediaType: generated.mediaType,
          title: mediaName(prompt, fileName),
          audio,
        }, ...companions.map(({ name, mediaType, role }) => ({ name, mediaType, role }))],
      };
      await mkdir(temporary, { recursive: true });
      await writeFile(path.join(temporary, fileName), generated.bytes);
      for (const companion of companions) await writeFile(path.join(temporary, companion.name), companion.text, "utf8");
      await writeFile(path.join(temporary, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
      await rename(temporary, destination);
      // Stored: there's nothing left for a retry to fetch.
      await journal.clear().catch(() => undefined);
      return publicRun(run);
    } catch (cause) {
      await rm(temporary, { recursive: true, force: true });
      if (cause instanceof ToolRunError) throw cause;
      if (cause instanceof AudioGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
      throw cause;
    }
  }

  async #videoReferences(projectId: string | undefined, references: VideoGenerationReference[]): Promise<VideoReferenceAsset[]> {
    if (!references.length) return [];
    try {
      return await Promise.all(references.map(async (reference) => {
        const asset = await this.#mediaFile(projectId, reference.path);
        const absolutePath = asset.absolutePath;
        if (asset.mediaType !== reference.type) throw new ToolRunError(`Reference ${asset.name} is not a ${reference.type} asset`, 400);
        if (!supportedVideoReferenceType(reference.type, asset.contentType)) {
          throw new ToolRunError(`Unsupported ${reference.type} reference format: ${asset.contentType}`, 400);
        }
        const maximum = reference.type === "image" ? 30 * 1024 * 1024
          : reference.type === "video" ? 200 * 1024 * 1024
            : 15 * 1024 * 1024;
        if (asset.size > maximum) throw new ToolRunError(`${reference.type} reference is too large`, 400);
        return { type: reference.type, name: asset.name, mediaType: asset.contentType, absolutePath };
      }));
    } catch (cause) {
      if (cause instanceof ToolRunError) throw cause;
      throw new ToolRunError(cause instanceof Error ? cause.message : String(cause), 400);
    }
  }

  async file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string; preview?: { bytes: Buffer; mediaType: "image/png" | "image/jpeg" } } | undefined> {
    if (!isRunId(runId) || !isToolRunFileName(fileName)) return undefined;
    try {
      const directory = path.join(this.#runsDirectory, runId);
      const run = await this.#readRun(runId);
      if (!run) return undefined;
      const file = run.files.find((candidate) => candidate.name === fileName);
      const filePath = path.join(directory, fileName);
      if (!file || !(await stat(filePath)).isFile()) return undefined;
      const preview = run.preview
        ? { bytes: await readFile(path.join(directory, run.preview.fileName)), mediaType: run.preview.mediaType }
        : undefined;
      return {
        bytes: await readFile(filePath),
        mediaType: file.mediaType,
        ...(preview ? { preview } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async removeRun(runId: string): Promise<void> {
    if (!isRunId(runId)) return;
    await rm(path.join(this.#runsDirectory, runId), { recursive: true, force: true });
  }

  async #readRun(runId: string): Promise<StoredToolRun | undefined> {
    try {
      const value = migrateLegacyAudioJob(JSON.parse(await readFile(path.join(this.#runsDirectory, runId, "run.json"), "utf8")) as Partial<StoredToolRun>);
      if (value.version !== 1 || value.id !== runId || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || !isToolId(value.toolId) || !Array.isArray(value.files)) return undefined;
      if (value.files.some((file) => !file || typeof file.name !== "string" || typeof file.mediaType !== "string" ||
        file.assetId !== undefined && typeof file.assetId !== "string")) return undefined;
      return value as StoredToolRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }
}

function isPromptImage(value: unknown, allowWebP = false): value is PromptImage {
  if (!value || typeof value !== "object") return false;
  const image = value as { mediaType?: unknown; data?: unknown };
  return (image.mediaType === "image/png" || image.mediaType === "image/jpeg" || (allowWebP && image.mediaType === "image/webp")) && typeof image.data === "string" && image.data.length > 0;
}

function validateVideoReferences(references: VideoGenerationReference[]): void {
  if (!Array.isArray(references) || references.some((reference) => !reference || typeof reference.path !== "string" || !reference.path || reference.type !== "image")) {
    throw new ToolRunError("Invalid video references", 400);
  }
}

function supportedVideoReferenceType(type: VideoGenerationReference["type"], contentType: string): boolean {
  if (type === "image") return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
  if (type === "video") return contentType === "video/mp4" || contentType === "video/quicktime";
  return contentType === "audio/mpeg" || contentType === "audio/wav";
}

function publicRun({ version: _, preview: __, ...run }: StoredToolRun): ToolRun {
  return { ...run, files: run.files.map((file) => ({ ...file })) };
}

/**
 * What a generation is called in the project it is saved to: the start of its prompt, such as `red-dragon-sprite.png`, rather than
 * the run's own `output.png`, which stays its name among the tool's runs.
 */
function mediaName(prompt: string, fileName: string): string {
  const stem = [...prompt.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-")].slice(0, 40).join("").replace(/^-+|-+$/g, "");
  if (!stem) return fileName;
  const index = /^output(-\d+)\./.exec(fileName)?.[1] ?? "";
  return `${stem}${index}${path.extname(fileName)}`;
}

function assertOnlyKeys(input: RunToolRequest, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key));
  if (unexpected) throw new ToolRunError(`Unexpected ${unexpected} option`, 400);
}

function isImageSize(value: unknown): value is ImageSize {
  return typeof value === "string" && IMAGE_SIZES.includes(value as ImageSize);
}

function isImageResolution(value: unknown): value is ImageResolution {
  return typeof value === "string" && IMAGE_RESOLUTIONS.includes(value as ImageResolution);
}

function isImageAspectRatio(value: unknown): value is ImageAspectRatio {
  return typeof value === "string" && IMAGE_ASPECT_RATIOS.includes(value as ImageAspectRatio);
}

function isImageOutputCount(value: unknown): value is ImageOutputCount {
  return typeof value === "number" && IMAGE_OUTPUT_COUNTS.includes(value as ImageOutputCount);
}

function isRunId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isToolRunFileName(value: string): boolean {
  return /^(?:output(?:-[1-4])?\.(?:png|jpg|webp|gif)|model\.glb|output\.(?:mp4|mp3|wav|ogg)(?:\.(?:audio\.json|srt|vtt))?)$/.test(value);
}

function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && TOOL_IDS.includes(value as ToolId);
}

function imageFileName(mediaType: string, index?: number): string {
  const suffix = index ? `-${index}` : "";
  return mediaType === "image/png" ? `output${suffix}.png` : mediaType === "image/jpeg" ? `output${suffix}.jpg` : mediaType === "image/gif" ? `output${suffix}.gif` : `output${suffix}.webp`;
}

function selectedModel(toolId: string, input: RunToolRequest): ModelRef | undefined {
  if (toolId === "generate-image") return (input as RunImageToolRequest).imageModel;
  if (toolId === "remove-image-background" || toolId === "generate-video" || toolId === "image-to-3d" || toolId === "animate-3d") return (input as RunVideoToolRequest | Run3DToolRequest).model;
  if (toolId === "generate-audio") return (input as AudioGenerationRequest).model;
  return undefined;
}

function validate3DOptions(options: Run3DToolRequest["options"]): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["pose", "textureModel", "textureQuality", "rigModel", "rigType", "animateInPlace"].includes(key))) throw new ToolRunError("Invalid 3D options", 400);
  if (options.pose !== undefined && !["a-pose", "t-pose"].includes(options.pose)
    || options.textureQuality !== undefined && !["fast", "standard", "detailed", "extreme"].includes(options.textureQuality)
    || options.rigModel !== undefined && !["v1.0-20240301", "v2.5-20260210", "v3.0-20260909"].includes(options.rigModel)
    || options.rigType !== undefined && !["biped", "quadruped", "hexapod", "octopod", "serpentine", "aquatic"].includes(options.rigType)
    || options.animateInPlace !== undefined && typeof options.animateInPlace !== "boolean"
    || options.textureModel !== undefined && (typeof options.textureModel !== "string" || !options.textureModel || options.textureModel.length > 120)) throw new ToolRunError("Unsupported 3D option", 400);
}

function validateOperationOptions(options: Run3DToolRequest["options"], operation: string, protocol?: string): void {
  const allowed = operation === "animate" && protocol === "tripo" ? ["rigModel", "rigType", "animateInPlace"]
    : operation === "retexture" && protocol === "tripo" ? ["textureModel", "textureQuality"]
    : operation === "retexture" && protocol === "meshy" ? ["textureModel"]
    : (operation === "image" || operation === "text") && (protocol === "meshy" || protocol === "hyper3d") ? ["pose"] : [];
  if (options && Object.entries(options).some(([key, value]) => value !== undefined && !allowed.includes(key))) throw new ToolRunError("These options are not supported by the selected 3D operation", 400);
}

function model3DToolError(cause: unknown): never {
  if (cause instanceof Model3DGenerationError) throw new ToolRunError(cause.message, cause.statusCode);
  throw cause;
}

interface GenerationLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}
