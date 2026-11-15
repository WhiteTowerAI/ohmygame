import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsWrites } from "./settings-writes.js";
import type { MinimaxProviderId } from "./minimax-models.js";

interface StoredMinimaxSettings extends Record<string, unknown> {
  version: 1;
  cnApiKey?: string;
  globalApiKey?: string;
}

const KEY_FIELDS = {
  "minimax-video-cn": "cnApiKey",
  "minimax-video-global": "globalApiKey",
} as const satisfies Record<MinimaxProviderId, keyof StoredMinimaxSettings>;

export class MinimaxSettingsStore {
  readonly #filePath: string;
  #settings: StoredMinimaxSettings = { version: 1 };
  #unreadable = false;

  constructor(dataDirectory: string, private readonly writes = new SettingsWrites()) {
    this.#filePath = path.join(dataDirectory, "minimax.json");
  }

  load(): Promise<void> {
    return this.writes.run(this, () => this.#load());
  }

  async #load(): Promise<void> {
    this.#unreadable = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).version !== 1)
        throw new Error(`Invalid MiniMax settings: ${this.#filePath}`);
      const stored = parsed as StoredMinimaxSettings;
      for (const field of Object.values(KEY_FIELDS))
        if (stored[field] !== undefined && typeof stored[field] !== "string")
          throw new Error(`Invalid MiniMax settings: ${this.#filePath}`);
      this.#settings = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#settings = { version: 1 };
    }
    this.#unreadable = false;
  }

  get(providerId: MinimaxProviderId): { configured: boolean } {
    return { configured: Boolean(this.key(providerId)) };
  }

  key(providerId: MinimaxProviderId): string | undefined {
    const value = this.#settings[KEY_FIELDS[providerId]];
    return typeof value === "string" ? value : undefined;
  }

  async update(providerId: MinimaxProviderId, value: string): Promise<{ configured: boolean }> {
    const normalized = value.trim();
    if (!normalized || !/^[\x21-\x7E]+$/.test(normalized)) throw new Error("API key must contain only printable ASCII characters");
    await this.#mutate(async () => {
      const next = { ...this.#settings, [KEY_FIELDS[providerId]]: normalized };
      await this.#persist(next);
      this.#settings = next;
    });
    return this.get(providerId);
  }

  async clear(providerId: MinimaxProviderId): Promise<void> {
    await this.#mutate(async () => {
      const next = { ...this.#settings };
      delete next[KEY_FIELDS[providerId]];
      if (Object.keys(next).every((field) => field === "version")) {
        await rm(this.#filePath, { force: true });
      } else {
        await this.#persist(next);
      }
      this.#settings = next;
    });
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    await this.writes.run(this, () => {
      if (this.#unreadable) throw new Error("MiniMax settings are unreadable; fix or update the file before changing settings");
      return operation();
    });
  }

  async #persist(settings: StoredMinimaxSettings): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(settings)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
