import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ImageModel,
  OpenAIImageConnectionMode,
  OpenAIImageModelConfiguration,
  SaveOpenAIImageConnectionRequest,
} from "../shared/contracts.js";
import { normalizeEndpoint } from "../shared/custom-models.js";
import { imageModelDefinition } from "./image-models.js";
import type { ImageSource } from "./image-adapters.js";

export const OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";

interface StoredSettings {
  version: 1;
  mode: OpenAIImageConnectionMode;
  baseUrl: string;
  apiKey?: string;
  models: OpenAIImageModelConfiguration[];
}

/** A separate image connection never changes Pi's chat credential or endpoint. */
export class OpenAIImageSettingsStore {
  readonly #filePath: string;
  #settings?: StoredSettings;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "openai-images.json");
  }

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (stored.version !== 1)
        throw new Error("Invalid OpenAI image settings");
      this.#settings = this.#normalize(stored);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      this.#settings = undefined;
    }
  }

  get() {
    const stored = this.#settings;
    return {
      mode: stored?.mode ?? ("connection" as const),
      baseUrl: stored?.baseUrl ?? OPENAI_IMAGE_BASE_URL,
      configured: Boolean(stored?.apiKey),
      models: structuredClone(stored?.models ?? []),
    };
  }

  source(
    baseUrl = this.#settings?.baseUrl ?? OPENAI_IMAGE_BASE_URL,
    apiKey?: string,
  ): ImageSource {
    const endpoint = normalizeEndpoint(baseUrl);
    const key =
      apiKey?.trim() ||
      (endpoint === this.#settings?.baseUrl
        ? this.#settings.apiKey
        : undefined);
    if (!key) throw new Error("Enter an image API key for this Base URL");
    if (!/^[\x21-\x7E]+$/.test(key))
      throw new Error(
        "Image API key must contain only printable ASCII characters",
      );
    return { baseUrl: endpoint, apiKey: key };
  }

  /** Undefined preserves the legacy discovered catalog until the user saves a list. */
  models(): ImageModel[] | undefined {
    return this.#settings?.models
      .filter((model) => model.enabled)
      .map(openAIConfiguredImageModel);
  }

  update(value: unknown): Promise<void> {
    return this.#enqueue(async () => {
      const next = this.#normalize(value);
      if (next.mode === "separate")
        next.apiKey = this.source(next.baseUrl, next.apiKey).apiKey;
      // Keep a saved separate credential when switching modes, so it can be selected again.
      else if (!next.apiKey && next.baseUrl === this.#settings?.baseUrl)
        next.apiKey = this.#settings.apiKey;
      await this.#write(next);
      this.#settings = next;
    });
  }

  /** Removing the image connection explicitly disables it instead of falling back to chat. */
  clear(disable = true): Promise<void> {
    return this.#enqueue(async () => {
      if (disable) {
        const next: StoredSettings = {
          version: 1,
          mode: "disabled",
          baseUrl: OPENAI_IMAGE_BASE_URL,
          models: [],
        };
        await this.#write(next);
        this.#settings = next;
      } else {
        await rm(this.#filePath, { force: true });
        this.#settings = undefined;
      }
    });
  }

  #normalize(value: unknown): StoredSettings {
    if (!value || typeof value !== "object")
      throw new Error("Invalid OpenAI image settings");
    const input = value as SaveOpenAIImageConnectionRequest;
    if (!["connection", "separate", "disabled"].includes(input.mode))
      throw new Error("Choose an image connection");
    const baseUrl = normalizeEndpoint(input.baseUrl);
    if (input.apiKey !== undefined && typeof input.apiKey !== "string")
      throw new Error("Invalid image API key");
    const apiKey = input.apiKey?.trim();
    if (apiKey && !/^[\x21-\x7E]+$/.test(apiKey))
      throw new Error("Invalid image API key");
    if (!Array.isArray(input.models) || input.models.length > 2_000)
      throw new Error("Provide up to 2,000 image models");
    const models = input.models.map(normalizeOpenAIImageModel);
    if (new Set(models.map((model) => model.id)).size !== models.length)
      throw new Error("Image model IDs must be unique");
    return {
      version: 1,
      mode: input.mode,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      models,
    };
  }

  async #write(value: StoredSettings): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.#pending.then(operation);
    this.#pending = pending.catch(() => {});
    return pending;
  }
}

function normalizeOpenAIImageModel(
  value: OpenAIImageModelConfiguration,
): OpenAIImageModelConfiguration {
  if (
    !value ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.trim().length > 200 ||
    /[\s\x00-\x1f]/.test(value.id.trim())
  )
    throw new Error("Enter a valid image model ID");
  if (
    typeof value.name !== "string" ||
    value.name.length > 200 ||
    /[\x00-\x1f]/.test(value.name)
  )
    throw new Error("Enter a valid image model name");
  if (
    !["gpt-image-1", "gpt-image-2"].includes(value.template) ||
    typeof value.enabled !== "boolean"
  )
    throw new Error("Choose an image model template and enable state");
  return {
    id: value.id.trim(),
    name: value.name.trim() || value.id.trim(),
    template: value.template,
    enabled: value.enabled,
  };
}

export function openAIConfiguredImageModel(
  model: OpenAIImageModelConfiguration,
): ImageModel {
  return {
    ...imageModelDefinition(model.template)!,
    id: model.id,
    name: model.name,
    provider: "openai",
    providerName: "OpenAI",
  };
}
