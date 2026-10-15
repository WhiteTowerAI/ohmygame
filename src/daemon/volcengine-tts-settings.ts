import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface StoredVolcengineTtsSettings {
  version: 1;
  apiKey?: string;
  defaultVoiceId?: string;
}

export class VolcengineTtsSettingsStore {
  readonly #filePath: string;
  #settings: StoredVolcengineTtsSettings = { version: 1 };
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "volcengine-tts.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as Record<string, unknown>;
      if (parsed.version !== 1)
        throw new Error(`Invalid Volcengine TTS settings: ${this.#filePath}`);
      this.#settings = {
        version: 1,
        ...(typeof parsed.apiKey === "string" && parsed.apiKey
          ? { apiKey: parsed.apiKey }
          : {}),
        ...(typeof parsed.defaultVoiceId === "string" && parsed.defaultVoiceId
          ? { defaultVoiceId: parsed.defaultVoiceId }
          : {}),
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  get(): { configured: boolean; defaultVoiceId?: string } {
    return {
      configured: Boolean(this.#settings.apiKey),
      ...(this.#settings.defaultVoiceId
        ? { defaultVoiceId: this.#settings.defaultVoiceId }
        : {}),
    };
  }
  key(): string | undefined {
    return this.#settings.apiKey;
  }
  defaultVoiceId(): string | undefined {
    return this.#settings.defaultVoiceId;
  }

  async update(
    apiKey?: string,
    defaultVoiceId?: string | null,
  ): Promise<{ configured: boolean; defaultVoiceId?: string }> {
    const normalized = apiKey?.trim();
    if (
      apiKey !== undefined &&
      (!normalized || !/^[\x21-\x7E]+$/.test(normalized))
    )
      throw new Error(
        "Volcengine TTS API key must contain only printable ASCII characters",
      );
    const voice = defaultVoiceId?.trim() || undefined;
    if (
      defaultVoiceId !== undefined &&
      defaultVoiceId !== null &&
      (!voice || !/^[A-Za-z0-9_-]{1,256}$/.test(voice))
    )
      throw new Error("Volcengine TTS Speaker ID is invalid");
    await this.#mutate(async () => {
      const nextApiKey = normalized ?? this.#settings.apiKey;
      if (!nextApiKey)
        throw new Error("Connect Volcengine TTS with an API key first");
      const next: StoredVolcengineTtsSettings = {
        version: 1,
        apiKey: nextApiKey,
        ...(defaultVoiceId === undefined
          ? this.#settings.defaultVoiceId
            ? { defaultVoiceId: this.#settings.defaultVoiceId }
            : {}
          : voice
            ? { defaultVoiceId: voice }
            : {}),
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
