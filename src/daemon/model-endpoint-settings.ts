import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface StoredEndpointSettings {
  version: 1;
  baseUrl: string;
}

export class ModelEndpointSettingsStore {
  readonly #filePath: string;
  #baseUrl: string | undefined;

  constructor(
    dataDirectory: string,
    fileName: string,
    readonly defaultBaseUrl: string,
    private readonly label: string,
  ) {
    this.#filePath = path.join(dataDirectory, fileName);
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (!this.#isStoredSettings(parsed)) throw new Error(`Invalid ${this.label} endpoint settings: ${this.#filePath}`);
      this.#baseUrl = parsed.baseUrl;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): { baseUrl: string } {
    return { baseUrl: this.#baseUrl ?? this.defaultBaseUrl };
  }

  override(): string | undefined {
    return this.#baseUrl;
  }

  async update(value: string): Promise<{ baseUrl: string }> {
    const baseUrl = this.#normalizedBaseUrl(value);
    if (baseUrl === this.defaultBaseUrl) {
      await rm(this.#filePath, { force: true });
      this.#baseUrl = undefined;
      return this.get();
    }
    const next: StoredEndpointSettings = { version: 1, baseUrl };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#filePath);
    this.#baseUrl = baseUrl;
    return this.get();
  }

  #normalizedBaseUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`${this.label} Base URL is not valid`);
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${this.label} Base URL is not valid`);
    }
    return url.toString().replace(/\/$/, "");
  }

  #isStoredSettings(value: unknown): value is StoredEndpointSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const settings = value as Record<string, unknown>;
    if (settings.version !== 1 || typeof settings.baseUrl !== "string") return false;
    try {
      return this.#normalizedBaseUrl(settings.baseUrl) !== this.defaultBaseUrl;
    } catch {
      return false;
    }
  }
}
