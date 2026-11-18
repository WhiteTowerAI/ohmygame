import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "./agent.js";
import { PluginModelError, type PluginModels } from "./plugin-models.js";
import { responseText } from "./text-generation.js";
import {
  PLUGIN_ASSISTANT_LIMITS,
  type PluginAssistantEntry,
  type PluginAssistantEvent,
  type PluginAssistantRequest,
  type PluginAssistantResult,
  type PluginAssistantToolUse,
} from "../shared/plugin-assistant.js";

// A panel's assistant (`host.assistant.run`): the app runs the person's model
// in a loop with the plugin's own tools and keeps the conversation for each
// panel of each project, apart from the project's chats. Each step is one
// request to the model, under the plugin's model limits.

type Context = Parameters<ModelRuntime["completeSimple"]>[1];
type Message = Context["messages"][number];

/** A conversation as it is kept: what a later version can tell apart. */
const THREAD_VERSION = 1;

export class PluginAssistantError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 | 500) {
    super(message);
  }
}

/** One of the plugin's tools as the assistant may use it: it answers with text, or throws why it failed. */
export interface PluginAssistantTool {
  name: string;
  description: string;
  /** Its input's JSON Schema. */
  parameters: unknown;
  run(input: unknown, signal: AbortSignal): Promise<string>;
}

export interface PluginAssistantRun {
  projectId: string;
  workspacePath: string;
  /** `publisher/name`. */
  plugin: string;
  panel: string;
  request: PluginAssistantRequest;
  tools: PluginAssistantTool[];
  onEvent(event: PluginAssistantEvent): void;
  signal: AbortSignal;
}

export class PluginAssistant {
  /** Conversations a run is adding to now; each runs one at a time. */
  readonly #running = new Set<string>();

  constructor(private readonly options: { directory: string; models: PluginModels }) {}

  /** A panel's conversation, oldest first. */
  async history(projectId: string, plugin: string, panel: string): Promise<PluginAssistantEntry[]> {
    return this.#read(this.#file(projectId, plugin, panel));
  }

  /** Forgets a panel's conversation, as the person may ask to start over. */
  async clear(projectId: string, plugin: string, panel: string): Promise<void> {
    const file = this.#file(projectId, plugin, panel);
    if (this.#running.has(file)) throw new PluginAssistantError("The assistant is still answering. Stop it first.", 409);
    await rm(file, { force: true });
  }

  async run(run: PluginAssistantRun): Promise<PluginAssistantResult> {
    const file = this.#file(run.projectId, run.plugin, run.panel);
    if (this.#running.has(file)) throw new PluginAssistantError("The assistant is still answering in this panel. Wait for it, or stop it.", 409);
    this.#running.add(file);
    try {
      return await this.#run(run, file);
    } finally {
      this.#running.delete(file);
    }
  }

  async #run(run: PluginAssistantRun, file: string): Promise<PluginAssistantResult> {
    const { request, signal } = run;
    // Read first, so a conversation that can't be read is never written over.
    const kept = await this.#read(file);
    const { runtime, model } = await this.options.models.choose(run.workspacePath, request.model);
    if (request.images?.length && !model.input.includes("image"))
      throw new PluginModelError(`${model.name} doesn't read images. Pick a model from models.list whose images is true.`, 400);
    const tools = new Map(run.tools.map((tool) => [tool.name, tool]));
    const context: Context = {
      ...(request.system ? { systemPrompt: request.system } : {}),
      messages: [
        ...this.#messages(model, kept),
        this.options.models.message(model, { role: "user", text: request.text, ...(request.images ? { images: request.images } : {}) }),
      ],
      ...(tools.size ? { tools: run.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters as never })) } : {}),
    };
    const at = () => new Date().toISOString();
    const added: PluginAssistantEntry[] = [{ role: "user", text: request.text, ...(request.images?.length ? { images: request.images.length } : {}), at: at() }];
    const usage = { input: 0, output: 0 };
    let text = "";
    let steps = 0;
    let stopped: PluginAssistantResult["stopped"];
    try {
      for (;;) {
        if (steps === PLUGIN_ASSISTANT_LIMITS.steps) {
          stopped = "steps";
          break;
        }
        steps++;
        // Each step gets the conversation as it is then.
        const response = await this.options.models.ask(run.plugin, runtime, model, { ...context, messages: [...context.messages] }, request.maxTokens, signal);
        usage.input += response.usage?.input ?? 0;
        usage.output += response.usage?.output ?? 0;
        if (response.stopReason === "error")
          throw new PluginModelError(response.errorMessage?.trim() || "The model couldn't answer. Try again or pick another model.", 502);
        const said = responseText(response);
        if (said) {
          text = said;
          run.onEvent({ type: "text", text: said });
        }
        const calls = response.content.filter((part) => part.type === "toolCall");
        const step: Extract<PluginAssistantEntry, { role: "assistant" }> = { role: "assistant", text: said, at: at() };
        context.messages.push(response);
        if (response.stopReason !== "toolUse" || !calls.length) {
          added.push(step);
          if (response.stopReason === "length") stopped = "length";
          break;
        }
        step.tools = [];
        // Kept with the step as each answers, so a stopped run keeps what its tools did.
        added.push(step);
        for (const call of calls) {
          signal.throwIfAborted();
          run.onEvent({ type: "tool", id: call.id, name: call.name, input: call.arguments });
          const used: PluginAssistantToolUse = { id: call.id, name: call.name, input: call.arguments, result: "" };
          const tool = tools.get(call.name);
          try {
            if (!tool) throw new Error(`There is no tool named ${call.name}. The tools: ${[...tools.keys()].join(", ") || "none"}`);
            used.result = cut(await tool.run(call.arguments, signal));
          } catch (cause) {
            if (signal.aborted) throw new PluginModelError("Cancelled", 409);
            used.result = cut(cause instanceof Error ? cause.message : String(cause));
            used.error = true;
          }
          step.tools.push(used);
          run.onEvent({ type: "tool.result", id: used.id, name: used.name, result: used.result, ...(used.error ? { error: true as const } : {}) });
          context.messages.push({
            role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: [{ type: "text", text: used.result }], isError: Boolean(used.error), timestamp: Date.now(),
          } as Message);
        }
      }
    } finally {
      // A run that answered at least once keeps what it did, even if it stopped after.
      if (added.length > 1) await this.#write(file, run.plugin, run.panel, [...kept, ...added]);
    }
    return { text, model: { provider: model.provider, id: model.id }, usage, steps, ...(stopped ? { stopped } : {}) };
  }

  /** A kept conversation as the model reads it again. Images aren't kept, so it is told there were some. */
  #messages(model: RuntimeModel, entries: PluginAssistantEntry[]): Message[] {
    const messages: Message[] = [];
    for (const entry of entries) {
      if (entry.role === "user") {
        const images = entry.images ? `[${entry.images} image${entry.images === 1 ? "" : "s"} sent here, not kept]` : "";
        messages.push(this.options.models.message(model, { role: "user", text: [entry.text, images].filter(Boolean).join("\n\n") }));
        continue;
      }
      const tools = entry.tools ?? [];
      if (!entry.text && !tools.length) continue;
      messages.push({
        role: "assistant",
        content: [
          ...(entry.text ? [{ type: "text" as const, text: entry.text }] : []),
          ...tools.map((tool) => ({ type: "toolCall" as const, id: tool.id, name: tool.name, arguments: (tool.input ?? {}) as never })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: tools.length ? "toolUse" : "stop",
        timestamp: Date.parse(entry.at) || Date.now(),
      } as Message);
      for (const tool of tools)
        messages.push({ role: "toolResult", toolCallId: tool.id, toolName: tool.name, content: [{ type: "text", text: tool.result }], isError: Boolean(tool.error), timestamp: Date.now() } as Message);
    }
    return messages;
  }

  #file(projectId: string, plugin: string, panel: string): string {
    const key = createHash("sha256").update(`${projectId}\0${plugin}\0${panel}`).digest("hex").slice(0, 32);
    return path.join(this.options.directory, key.slice(0, 2), `${key}.json`);
  }

  async #read(file: string): Promise<PluginAssistantEntry[]> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    try {
      const value = JSON.parse(text) as { version?: unknown; entries?: unknown };
      if (value.version === THREAD_VERSION && Array.isArray(value.entries)) return value.entries as PluginAssistantEntry[];
    } catch {
      // Below: it isn't one this version reads.
    }
    throw new PluginAssistantError("This panel's conversation was kept by another version of OhMyGame and can't be read here. Clear it to start a new one.", 409);
  }

  /** Keeps the newest of a conversation within its limits, starting at one of the person's messages. */
  async #write(file: string, plugin: string, panel: string, entries: PluginAssistantEntry[]): Promise<void> {
    let start = Math.max(0, entries.length - PLUGIN_ASSISTANT_LIMITS.entries);
    const size = (entry: PluginAssistantEntry) => entry.text.length + (entry.role === "assistant" ? (entry.tools ?? []).reduce((sum, tool) => sum + tool.result.length + JSON.stringify(tool.input ?? null).length, 0) : 0);
    let chars = entries.slice(start).reduce((sum, entry) => sum + size(entry), 0);
    while (start < entries.length - 1 && (chars > PLUGIN_ASSISTANT_LIMITS.chars || entries[start]!.role !== "user")) chars -= size(entries[start++]!);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: THREAD_VERSION, plugin, panel, entries: entries.slice(start) }));
    await rename(temporary, file);
  }
}

function cut(text: string): string {
  return text.length > PLUGIN_ASSISTANT_LIMITS.resultChars ? `${text.slice(0, PLUGIN_ASSISTANT_LIMITS.resultChars)}\n… (cut at ${PLUGIN_ASSISTANT_LIMITS.resultChars.toLocaleString("en")} characters)` : text;
}
