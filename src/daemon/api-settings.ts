import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ApiSettings {
  apiUrl: string;
  hasApiKey: boolean;
}

export interface UpdateApiSettings {
  apiUrl: string;
  apiKey?: string;
}

interface StoredApiSettings {
  version: 1;
  apiUrl: string;
  apiKey?: string;
}

export class ApiSettingsStore {
  readonly #filePath: string;
  #stored: StoredApiSettings | undefined;

  constructor(
    dataDirectory: string,
    fileName: string,
    private readonly defaultApiUrl: string,
    private readonly label: string,
    private readonly fallback: { apiUrl?: string; apiKey?: string } = {},
  ) {
    this.#filePath = path.join(dataDirectory, fileName);
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (!this.#isStoredSettings(parsed)) throw new Error(`Invalid ${this.label} settings: ${this.#filePath}`);
      this.#stored = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): ApiSettings {
    const resolved = this.resolve();
    return { apiUrl: resolved.apiUrl, hasApiKey: Boolean(resolved.apiKey) };
  }

  resolve(): { apiUrl: string; apiKey?: string } {
    const apiUrl = this.#stored?.apiUrl ?? this.#normalizedApiUrl(this.fallback.apiUrl ?? this.defaultApiUrl);
    const apiKey = this.#stored?.apiKey ?? (this.fallback.apiKey?.trim() || undefined);
    return { apiUrl, ...(apiKey ? { apiKey } : {}) };
  }

  async update(input: UpdateApiSettings): Promise<ApiSettings> {
    const apiUrl = this.#normalizedApiUrl(input.apiUrl);
    const apiKey = input.apiKey?.trim() || this.#stored?.apiKey;
    const next: StoredApiSettings = { version: 1, apiUrl, ...(apiKey ? { apiKey } : {}) };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#filePath);
    this.#stored = next;
    return this.get();
  }

  #normalizedApiUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`${this.label} API endpoint is not valid`);
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${this.label} API endpoint is not valid`);
    }
    return url.toString().replace(/\/$/, "");
  }

  #isStoredSettings(value: unknown): value is StoredApiSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const settings = value as Record<string, unknown>;
    if (settings.version !== 1 || typeof settings.apiUrl !== "string") return false;
    if (settings.apiKey !== undefined && typeof settings.apiKey !== "string") return false;
    try {
      this.#normalizedApiUrl(settings.apiUrl);
      return true;
    } catch {
      return false;
    }
  }
}
