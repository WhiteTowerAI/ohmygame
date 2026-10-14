import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MinimaxProviderId } from "./minimax-models.js";

interface StoredMinimaxSettings {
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
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "minimax.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1) throw new Error(`Invalid MiniMax settings: ${this.#filePath}`);
      this.#settings = {
        version: 1,
        ...apiKey("cnApiKey", parsed.cnApiKey),
        ...apiKey("globalApiKey", parsed.globalApiKey),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
      if (!next.cnApiKey && !next.globalApiKey) {
        await rm(this.#filePath, { force: true });
      } else {
        await this.#persist(next);
      }
      this.#settings = next;
    });
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.#mutations.then(operation);
    this.#mutations = pending.catch(() => undefined);
    await pending;
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

function apiKey<Key extends "cnApiKey" | "globalApiKey">(
  key: Key,
  value: unknown,
): Partial<Pick<StoredMinimaxSettings, Key>> {
  return typeof value === "string" && value ? { [key]: value } as Pick<StoredMinimaxSettings, Key> : {};
}
