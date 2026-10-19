import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOUBAO_SEED_AUDIO_PROVIDER_NAME } from "../shared/audio.js";

interface StoredVolcengineSeedAudioSettings {
  version: 1;
  apiKey?: string;
}

export class VolcengineSeedAudioSettingsStore {
  readonly #filePath: string;
  #settings: StoredVolcengineSeedAudioSettings = { version: 1 };
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "volcengine-seed-audio.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as Record<string, unknown>;
      if (parsed.version !== 1)
        throw new Error(
          `Invalid ${DOUBAO_SEED_AUDIO_PROVIDER_NAME} settings: ${this.#filePath}`,
        );
      this.#settings = {
        version: 1,
        ...(typeof parsed.apiKey === "string" && parsed.apiKey
          ? { apiKey: parsed.apiKey }
          : {}),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  get(): { configured: boolean } {
    return { configured: Boolean(this.#settings.apiKey) };
  }

  key(): string | undefined {
    return this.#settings.apiKey;
  }

  async update(apiKey: string): Promise<{ configured: boolean }> {
    const normalized = apiKey.trim();
    if (!normalized || !/^[\x21-\x7E]+$/.test(normalized))
      throw new Error(
        `${DOUBAO_SEED_AUDIO_PROVIDER_NAME} API key must contain only printable ASCII characters`,
      );
    await this.#mutate(async () => {
      const next: StoredVolcengineSeedAudioSettings = {
        version: 1,
        apiKey: normalized,
      };
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.#filePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      this.#settings = next;
    });
    return this.get();
  }

  async clear(): Promise<void> {
    await this.#mutate(async () => {
      await rm(this.#filePath, { force: true });
      this.#settings = { version: 1 };
    });
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.#mutations.then(operation);
    this.#mutations = pending.catch(() => undefined);
    await pending;
  }
}
