import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageModelRef, ImageGenerationSettings } from "../shared/contracts.js";

interface StoredSettings {
  version: 2;
  model?: ImageModelRef;
}

export class ImageSettingsStore {
  readonly #filePath: string;
  #settings: ImageGenerationSettings = {};

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "image-settings.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (isLegacy(value)) return;
      if (!isStored(value)) throw new Error(`Invalid image settings: ${this.#filePath}`);
      this.#settings = value.model ? { model: { ...value.model } } : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): ImageGenerationSettings {
    return this.#settings.model ? { model: { ...this.#settings.model } } : {};
  }

  async update(model: ImageModelRef | undefined): Promise<ImageGenerationSettings> {
    const next: StoredSettings = { version: 2, ...(model ? { model } : {}) };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#filePath);
    this.#settings = model ? { model: { ...model } } : {};
    return this.get();
  }
}

function isStored(value: unknown): value is StoredSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { version?: unknown; model?: unknown };
  if (candidate.version !== 2) return false;
  if (candidate.model === undefined) return true;
  if (!candidate.model || typeof candidate.model !== "object" || Array.isArray(candidate.model)) return false;
  const model = candidate.model as { provider?: unknown; id?: unknown };
  return typeof model.provider === "string" && Boolean(model.provider) && typeof model.id === "string" && Boolean(model.id);
}

function isLegacy(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { version?: unknown }).version === 1);
}
