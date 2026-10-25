import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Service = "volcengine-tts" | "volcengine-seed-audio";
interface Settings {
  version: 1;
  apiKey?: string;
  services: Partial<Record<Service, string | null>>;
}
/** A shared connection, with lossless overrides for two different legacy credentials. */
export class DoubaoVoiceSettingsStore {
  #settings: Settings = { version: 1, services: {} };
  #mutations = Promise.resolve();
  readonly #file: string;
  constructor(directory: string) {
    this.#file = path.join(directory, "doubao-voice.json");
  }
  async load(legacy: Partial<Record<Service, string>>): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.#file, "utf8")) as Settings;
      if (
        value.version !== 1 ||
        !value.services ||
        typeof value.services !== "object"
      )
        throw new Error("Invalid Doubao Voice settings");
      this.#settings = value;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const values = Object.values(legacy).filter(Boolean);
      this.#settings =
        values.length === 2 && values[0] === values[1]
          ? { version: 1, apiKey: values[0], services: {} }
          : { version: 1, services: { ...legacy } };
    }
  }
  key(service: Service): string | undefined {
    return this.#settings.services[service] === null
      ? undefined
      : (this.#settings.services[service] ?? this.#settings.apiKey);
  }
  get() {
    const tts = this.key("volcengine-tts"),
      seed = this.key("volcengine-seed-audio");
    return {
      configured: Boolean(tts || seed),
      shared: Boolean(this.#settings.apiKey),
      distinctKeys: Boolean(tts && seed && tts !== seed),
      ttsConfigured: Boolean(tts),
      seedConfigured: Boolean(seed),
    };
  }
  async update(key: string): Promise<void> {
    const apiKey = this.#validate(key);
    await this.#mutate(() => ({ version: 1, apiKey, services: {} }));
  }
  async setService(service: Service, key: string | null): Promise<void> {
    const value = key === null ? null : this.#validate(key);
    await this.#mutate(() => ({
      ...this.#settings,
      services: { ...this.#settings.services, [service]: value },
    }));
  }
  #validate(key: string): string {
    const value = key.trim();
    if (!value || !/^[\x21-\x7E]+$/.test(value))
      throw new Error(
        "Doubao API key must contain printable ASCII characters only",
      );
    return value;
  }
  async #mutate(next: () => Settings): Promise<void> {
    const pending = this.#mutations.then(async () => {
      const settings = next();
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(settings)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.#file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.#settings = settings;
    });
    this.#mutations = pending.catch(() => {});
    await pending;
  }
}
