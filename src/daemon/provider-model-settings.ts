import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { CUSTOM_MODEL_APIS, type CustomProviderModel, type ModelRef } from "../shared/contracts.js";

type JsonObject = Record<string, unknown>;

export class ProviderModelSettingsStore {
  readonly #preferencesPath: string;
  readonly #modelsPath: string;
  #hidden: Record<string, string[]> = {};
  #pending: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string, piAgentDirectory: string) {
    this.#preferencesPath = path.join(dataDirectory, "model-visibility.json");
    this.#modelsPath = path.join(piAgentDirectory, "models.json");
  }

  async load(): Promise<void> {
    const text = await readOptional(this.#preferencesPath);
    if (!text) return;
    const stored = JSON.parse(text) as { version?: unknown; hidden?: unknown };
    if (stored.version !== 1 || !isObject(stored.hidden) || Object.values(stored.hidden).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) throw new Error("Invalid model visibility settings");
    this.#hidden = stored.hidden as Record<string, string[]>;
  }

  isVisible(model: ModelRef): boolean {
    const hidden = this.#hidden[model.provider];
    return !Array.isArray(hidden) || !hidden.includes(model.id);
  }

  setVisibility(provider: string, ids: string[], visible: boolean): Promise<void> {
    return this.#enqueue(async () => {
      const hidden = new Set(Array.isArray(this.#hidden[provider]) ? this.#hidden[provider] : []);
      for (const id of ids) visible ? hidden.delete(id) : hidden.add(id);
      const next = { ...this.#hidden, [provider]: [...hidden] };
      await writeAtomic(this.#preferencesPath, `${JSON.stringify({ version: 1, hidden: next }, null, 2)}\n`);
      this.#hidden = next;
    });
  }

  async customModels(provider: string): Promise<JsonObject[]> {
    const { config } = await this.#readModels();
    const entry = isObject(config.providers) ? config.providers[provider] : undefined;
    return isObject(entry) && Array.isArray(entry.models) ? entry.models.filter(isObject) : [];
  }

  addCustomModel(provider: string, model: CustomProviderModel): Promise<void> {
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const entry = isObject(config.providers) ? config.providers[provider] : undefined;
      const models = isObject(entry) && Array.isArray(entry.models) ? entry.models : [];
      if (models.some((item) => isObject(item) && item.id === model.id)) throw new Error("A model with this ID already exists");
      const definition = {
        id: model.id, name: model.name, api: model.api,
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        reasoning: model.reasoning, input: model.supportsImages ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const contents = applyEdits(text, modify(text, ["providers", provider, "models"], [...models, definition], { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await writeAtomic(this.#modelsPath, contents);
    });
  }

  removeCustomModel(provider: string, id: string): Promise<void> {
    return this.#enqueue(async () => {
      const { text, config } = await this.#readModels();
      const entry = isObject(config.providers) ? config.providers[provider] : undefined;
      const models = isObject(entry) && Array.isArray(entry.models) ? entry.models : [];
      const index = models.findIndex((item) => isObject(item) && item.id === id);
      if (index < 0) throw new Error("Custom model not found");
      const contents = applyEdits(text, modify(text, ["providers", provider, "models", index], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await writeAtomic(this.#modelsPath, contents);
    });
  }

  async #readModels(): Promise<{ text: string; config: JsonObject }> {
    const text = await readOptional(this.#modelsPath) ?? "{}\n";
    const errors: ParseError[] = [];
    const config: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !isObject(config) || (config.providers !== undefined && !isObject(config.providers))) throw new Error("Invalid models.json; fix it before editing models");
    return { text, config };
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }
}

export function normalizeCustomProviderModel(value: unknown, defaultApi: string, defaultBaseUrl?: string): CustomProviderModel {
  if (!isObject(value)) throw new Error("Invalid custom model");
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || !name || name.length > 200) throw new Error("Model ID and name are required (up to 200 characters)");
  const api = typeof value.api === "string" ? value.api : defaultApi;
  if (api !== defaultApi && !CUSTOM_MODEL_APIS.some((known) => known === api)) throw new Error("Unsupported model API");
  const contextWindow = value.contextWindow;
  const maxTokens = value.maxTokens;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1 || contextWindow > 100_000_000 || typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error("Token limits must be positive integers, with output tokens no greater than context size");
  if (typeof value.reasoning !== "boolean" || typeof value.supportsImages !== "boolean") throw new Error("Invalid model capabilities");
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : undefined;
  if (!baseUrl && !defaultBaseUrl) throw new Error("Model Base URL is required for this provider");
  if (baseUrl) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error("Invalid model Base URL"); }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid model Base URL");
  }
  return { id, name, api, ...(baseUrl ? { baseUrl: baseUrl.replace(/\/$/, "") } : {}), contextWindow, maxTokens, reasoning: value.reasoning, supportsImages: value.supportsImages };
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try { return await readFile(filePath, "utf8"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; return undefined; }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }); }
}
