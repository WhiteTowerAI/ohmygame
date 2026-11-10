import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface Settings { version: 1; apiKey?: string }

/** Credentials for ElevenLabs are local daemon state, never canvas data. */
export class ElevenLabsSettingsStore {
  #settings: Settings = { version: 1 };
  readonly #file: string;
  constructor(directory: string) { this.#file = path.join(directory, "elevenlabs.json"); }
  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#file, "utf8")) as Settings;
      if (value.version === 1 && (value.apiKey === undefined || typeof value.apiKey === "string")) this.#settings = value;
      else throw new Error("Invalid ElevenLabs settings");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  key(): string | undefined { return this.#settings.apiKey; }
  get(): { configured: boolean } { return { configured: Boolean(this.key()) }; }
  async update(value: { apiKey: string }): Promise<{ configured: boolean }> {
    const apiKey = value.apiKey.trim();
    if (!apiKey || !/^[\x21-\x7E]+$/.test(apiKey)) throw new Error("ElevenLabs API key is invalid");
    const next: Settings = { version: 1, apiKey };
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, this.#file); }
    finally { await rm(temporary, { force: true }); }
    this.#settings = next;
    return this.get();
  }
  async clear(): Promise<void> { await rm(this.#file, { force: true }); this.#settings = { version: 1 }; }
}
