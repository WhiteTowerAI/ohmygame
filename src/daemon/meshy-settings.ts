import { mkdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class MeshySettingsStore {
  readonly #filePath: string;
  #apiKey: string | undefined;

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "meshy.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#filePath, "utf8")) as { version?: unknown; apiKey?: unknown };
      this.#apiKey = value.version === 1 && typeof value.apiKey === "string" ? value.apiKey : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): { configured: boolean } {
    return { configured: Boolean(this.#apiKey) };
  }

  key(): string | undefined {
    return this.#apiKey;
  }

  async update(apiKey: string): Promise<{ configured: boolean }> {
    const value = apiKey.trim();
    if (!value || !/^[\x21-\x7E]+$/.test(value)) throw new Error("Meshy API key is invalid");
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, apiKey: value })}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#filePath);
    this.#apiKey = value;
    return this.get();
  }

  async clear(): Promise<void> {
    this.#apiKey = undefined;
    await rm(this.#filePath, { force: true });
  }
}
