import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "./agent.js";
import { clampReasoningLevel, supportedReasoningLevels } from "../shared/reasoning.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { PLUGIN_MODEL_LIMITS, type PluginModelInfo, type PluginModelRequest, type PluginModelResult } from "../shared/plugin-models.js";
import { modelOptions, responseText } from "./text-generation.js";
import { PluginLimits } from "./plugin-limits.js";

// Plugins asking the person's models (`capabilities.models`), from a page or
// native code. Each request runs on the person's providers and counts toward
// their use, so a plugin gets a few at a time, and each one is written in its
// log with what it used.

/** Room a model that can't stop thinking gets besides what the plugin asked for. */
const THINKING_TOKENS = 4_096;

export class PluginModelError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 | 429 | 502 | 504) {
    super(message);
  }
}

export interface PluginModelsOptions {
  runtime(): Promise<ModelRuntime>;
  /** The models the person turned on, set up and shows. */
  models(runtime: ModelRuntime): Promise<RuntimeModel[]>;
  /** The project's default model, or the app's without a project. */
  defaultModel(workspacePath?: string): { provider: string; id: string } | undefined;
  /** Writes a line in the plugin's log. */
  log(plugin: string, text: string): void;
  now?(): number;
}

type Message = Parameters<ModelRuntime["completeSimple"]>[1]["messages"][number];

export class PluginModels {
  readonly #limits: PluginLimits;

  constructor(private readonly options: PluginModelsOptions) {
    this.#limits = new PluginLimits({ concurrent: PLUGIN_MODEL_LIMITS.concurrent, perMinute: PLUGIN_MODEL_LIMITS.perMinute, ...(options.now ? { now: options.now } : {}) });
  }

  async list(workspacePath?: string): Promise<PluginModelInfo[]> {
    const models = await this.options.models(await this.options.runtime());
    const chosen = this.#default(models, workspacePath);
    return models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      images: model.input.includes("image"),
      ...(model === chosen ? { default: true as const } : {}),
    }));
  }

  async complete(plugin: string, workspacePath: string | undefined, request: PluginModelRequest, signal?: AbortSignal): Promise<PluginModelResult> {
    const runtime = await this.options.runtime();
    const models = await this.options.models(runtime);
    const model = request.model
      ? models.find((item) => item.provider === request.model!.provider && item.id === request.model!.id)
      : this.#default(models, workspacePath);
    if (!model) throw new PluginModelError(request.model ? "That model isn't one the person set up. Pick one from models.list." : "No language model is set up. Ask the person to choose one in Settings.", 409);
    if (request.messages.some((message) => message.images?.length) && !model.input.includes("image"))
      throw new PluginModelError(`${model.name} doesn't read images. Pick a model from models.list whose images is true.`, 400);
    // Only a request that reaches a provider counts toward the limits.
    const release = this.#take(plugin);
    try {
      const timeout = AbortSignal.timeout(PLUGIN_MODEL_LIMITS.timeoutMs);
      const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const reasoning = clampReasoningLevel("off", supportedReasoningLevels(model));
      const system = [request.system, request.json ? "Answer with JSON only, without code fences or commentary." : undefined].filter(Boolean).join("\n\n");
      let response: Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
      try {
        response = await runtime.completeSimple(model, {
          ...(system ? { systemPrompt: system } : {}),
          messages: request.messages.map((message) => this.#message(model, message)),
        }, {
          // A model that always thinks gets room for it, so its answer isn't cut to nothing.
          maxTokens: Math.min(model.maxTokens, (request.maxTokens ?? PLUGIN_MODEL_LIMITS.defaultMaxTokens) + (reasoning === "off" ? 0 : THINKING_TOKENS)),
          maxRetries: 0,
          signal: stop,
          ...modelOptions(model, reasoning),
        });
      } catch (cause) {
        // A provider that throws rather than answering with a stop reason, such as on abort.
        this.options.log(plugin, `Asked ${model.provider}/${model.id}: failed`);
        if (timeout.aborted) throw new PluginModelError(`The model didn't answer in ${PLUGIN_MODEL_LIMITS.timeoutMs / 1000} seconds`, 504);
        if (signal?.aborted) throw new PluginModelError("Cancelled", 409);
        throw new PluginModelError(cause instanceof Error && cause.message ? cause.message : "The model couldn't answer. Try again or pick another model.", 502);
      }
      const usage = { input: response.usage?.input ?? 0, output: response.usage?.output ?? 0 };
      this.options.log(plugin, `Asked ${model.provider}/${model.id}: ${usage.input} tokens in, ${usage.output} out${response.stopReason === "stop" || response.stopReason === "length" ? "" : ` (${response.stopReason})`}`);
      if (timeout.aborted) throw new PluginModelError(`The model didn't answer in ${PLUGIN_MODEL_LIMITS.timeoutMs / 1000} seconds`, 504);
      if (response.stopReason === "aborted" || signal?.aborted) throw new PluginModelError("Cancelled", 409);
      if (response.stopReason !== "stop" && response.stopReason !== "length")
        throw new PluginModelError(response.errorMessage?.trim() || "The model couldn't answer. Try again or pick another model.", 502);
      const text = responseText(response);
      const result: PluginModelResult = { text, model: { provider: model.provider, id: model.id }, usage, stopReason: response.stopReason };
      if (!request.json) return result;
      try {
        return { ...result, json: JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i, "$1")) };
      } catch {
        throw new PluginModelError(response.stopReason === "length" ? "The answer stopped at maxTokens before its JSON was complete" : "The model's answer isn't JSON", 502);
      }
    } finally {
      release();
    }
  }

  /** The default model, or the first one when none is set or it isn't one of these, as the app's own pickers do. */
  #default(models: RuntimeModel[], workspacePath?: string) {
    return preferredAgentModel(models, undefined, this.options.defaultModel(workspacePath));
  }

  #message(model: RuntimeModel, message: PluginModelRequest["messages"][number]): Message {
    if (message.role === "assistant")
      return {
        role: "assistant",
        content: [{ type: "text", text: message.text }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as Message;
    const content = message.images?.length
      ? [...(message.text ? [{ type: "text" as const, text: message.text }] : []), ...message.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.type }))]
      : message.text;
    return { role: "user", content, timestamp: Date.now() } as Message;
  }

  /** Counts a request toward the plugin's limits, or refuses it. */
  #take(plugin: string): () => void {
    const taken = this.#limits.take(plugin);
    if (taken.ok) return () => taken.release();
    throw new PluginModelError(taken.reached === "concurrent"
      ? `A plugin asks at most ${PLUGIN_MODEL_LIMITS.concurrent} things of a model at once. Wait for one to finish.`
      : `A plugin asks a model at most ${PLUGIN_MODEL_LIMITS.perMinute} times a minute. Wait a moment.`, 429);
  }
}
