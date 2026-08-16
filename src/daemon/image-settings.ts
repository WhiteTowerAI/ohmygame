import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageGenerationSettings, UpdateImageGenerationSettings } from "../shared/contracts.js";

const DEFAULT_API_URL = "https://api.openai.com/v1";

interface StoredImageSettings {
  version: 1;
  apiUrl: string;
  apiKey?: string;
}

export class ImageSettingsStore {
  readonly #filePath: string;
  #stored: StoredImageSettings | undefined;

  constructor(
    dataDirectory: string,
    private readonly fallback: { apiUrl?: string; apiKey?: string } = {},
  ) {
    this.#filePath = path.join(dataDirectory, "image-settings.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (!isStoredSettings(parsed)) throw new Error(`Invalid image settings: ${this.#filePath}`);
      this.#stored = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): ImageGenerationSettings {
    const resolved = this.resolve();
    return { apiUrl: resolved.apiUrl, hasApiKey: Boolean(resolved.apiKey) };
  }

  resolve(): { apiUrl: string; apiKey?: string } {
    const apiUrl = this.#stored?.apiUrl ?? normalizedApiUrl(this.fallback.apiUrl ?? DEFAULT_API_URL);
    const apiKey = this.#stored?.apiKey ?? (this.fallback.apiKey?.trim() || undefined);
    return { apiUrl, ...(apiKey ? { apiKey } : {}) };
  }

  async update(input: UpdateImageGenerationSettings): Promise<ImageGenerationSettings> {
    const apiUrl = normalizedApiUrl(input.apiUrl);
    const apiKey = input.apiKey?.trim() || this.#stored?.apiKey;
    const next: StoredImageSettings = { version: 1, apiUrl, ...(apiKey ? { apiKey } : {}) };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#filePath);
    this.#stored = next;
    return this.get();
  }
}

function normalizedApiUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Image API endpoint is not valid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Image API endpoint is not valid");
  }
  return url.toString().replace(/\/$/, "");
}

function isStoredSettings(value: unknown): value is StoredImageSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  if (settings.version !== 1 || typeof settings.apiUrl !== "string") return false;
  if (settings.apiKey !== undefined && typeof settings.apiKey !== "string") return false;
  try {
    normalizedApiUrl(settings.apiUrl);
    return true;
  } catch {
    return false;
  }
}
