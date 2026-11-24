import type { AudioKind } from "../shared/audio.js";
import type { RunToolRequest, ToolRun } from "../shared/contracts.js";
import { PLUGIN_GENERATION_LIMITS, type PluginGenerationKind, type PluginGenerationRequest, type PluginGenerationResult } from "../shared/plugin-generation.js";
import { PluginLimits } from "./plugin-limits.js";
import { ToolRunError } from "./tools.js";

// Plugins making images and audio with the person's models
// (`capabilities.media`). Each request runs the way the app's own generation
// does, through the same tool runner, so plugins' image hooks, recovery and
// the Library all apply; it costs the person, so a plugin gets a few at a
// time, and each one is written in its log.

export class PluginGenerationError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

export interface PluginGenerationOptions {
  tools: {
    run(toolId: string, input: RunToolRequest, signal?: AbortSignal, projectId?: string, options?: { addedBy?: string }): Promise<ToolRun>;
    file(runId: string, fileName: string): Promise<{ bytes: Buffer; mediaType: string; assetId?: string } | undefined>;
    removeRun(runId: string): Promise<void>;
  };
  /** The project's connected models of a kind, and the one a request without a model uses. */
  models(projectId: string, media: PluginGenerationKind, kind?: AudioKind, signal?: AbortSignal): Promise<{ default?: { provider: string; id: string }; models: unknown[] }>;
  /** Writes a line in the plugin's log. */
  log(plugin: string, text: string): void;
  now?(): number;
}

export class PluginGeneration {
  readonly #limits: PluginLimits;

  constructor(private readonly options: PluginGenerationOptions) {
    this.#limits = new PluginLimits({ concurrent: PLUGIN_GENERATION_LIMITS.concurrent, perMinute: PLUGIN_GENERATION_LIMITS.perMinute, ...(options.now ? { now: options.now } : {}) });
  }

  models(projectId: string, media: PluginGenerationKind, kind?: AudioKind) {
    return this.options.models(projectId, media, kind);
  }

  /** Makes what a request asks for in a project; the Library shows it as added by the plugin. */
  async generate(plugin: string, projectId: string, request: PluginGenerationRequest, signal: AbortSignal): Promise<PluginGenerationResult> {
    const taken = this.#limits.take(plugin);
    if (!taken.ok) throw new PluginGenerationError(taken.reached === "concurrent"
      ? `A plugin makes at most ${PLUGIN_GENERATION_LIMITS.concurrent} things at once. Wait for one to finish.`
      : `A plugin makes at most ${PLUGIN_GENERATION_LIMITS.perMinute} things a minute. Wait a moment.`, 429);
    const toolId = request.media === "image" ? "generate-image" : "generate-audio";
    let run: ToolRun | undefined;
    try {
      run = await this.options.tools.run(toolId, toolInput(request), signal, projectId, { addedBy: plugin });
      const made = run.model ? ` with ${run.model.provider}/${run.model.id}` : "";
      // An audio run keeps subtitles and metadata beside the sound; the plugin gets the sound.
      const outputs = run.files.filter((file) => !file.role || file.role === "audio");
      this.options.log(plugin, `Made ${request.media === "audio" ? "audio" : `${outputs.length} image${outputs.length === 1 ? "" : "s"}`}${made}`);
      const files = [];
      for (const output of outputs) {
        const file = await this.options.tools.file(run.id, output.name);
        if (!file) throw new PluginGenerationError("What the model made couldn't be read", 502);
        files.push({ name: output.name, type: file.mediaType, data: file.bytes.toString("base64"), ...(file.assetId ? { assetId: file.assetId } : {}) });
      }
      return { ...(run.model ? { model: { provider: run.model.provider, id: run.model.id } } : {}), files };
    } catch (cause) {
      if (!run) this.options.log(plugin, `Making ${request.media === "audio" ? "audio" : "an image"}: ${signal.aborted ? "stopped" : `failed: ${cause instanceof Error ? cause.message : String(cause)}`}`);
      if (signal.aborted) throw new PluginGenerationError("Cancelled", 409);
      if (cause instanceof ToolRunError) throw new PluginGenerationError(cause.message, cause.statusCode);
      throw cause;
    } finally {
      // What it made stays in the Library; the run's own copy isn't needed.
      if (run) await this.options.tools.removeRun(run.id).catch(() => undefined);
      taken.release();
    }
  }
}

/** A plugin's request as the app's own generation takes it. */
function toolInput(request: PluginGenerationRequest): RunToolRequest {
  if (request.media === "audio") {
    const { media: _, ...audio } = request;
    return audio as RunToolRequest;
  }
  const { media: _, model, images, ...image } = request;
  return {
    ...image,
    ...(model ? { imageModel: model } : {}),
    ...(images ? { images: images.map((item) => ({ mediaType: item.type, data: item.data })) } : {}),
  } as RunToolRequest;
}
