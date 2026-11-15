import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SettingsWrites } from "./settings-writes.js";
import type { SeedanceProviderId } from "./seedance-models.js";

interface StoredSeedanceSettings extends Record<string, unknown> {
  version: 1;
  volcengineApiKey?: string;
  byteplusApiKey?: string;
}

const KEY_FIELDS = {
  "volcengine-ark": "volcengineApiKey",
  "byteplus-modelark": "byteplusApiKey",
} as const satisfies Record<SeedanceProviderId, keyof StoredSeedanceSettings>;

export class SeedanceSettingsStore {
  readonly #filePath: string;
  #settings: StoredSeedanceSettings = { version: 1 };
  #unreadable = false;

  constructor(dataDirectory: string, private readonly writes = new SettingsWrites()) {
    this.#filePath = path.join(dataDirectory, "seedance.json");
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
        throw new Error(`Invalid Seedance settings: ${this.#filePath}`);
      const stored = parsed as StoredSeedanceSettings;
      for (const field of Object.values(KEY_FIELDS))
        if (stored[field] !== undefined && typeof stored[field] !== "string")
          throw new Error(`Invalid Seedance settings: ${this.#filePath}`);
      this.#settings = stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#settings = { version: 1 };
    }
    this.#unreadable = false;
  }

  get(providerId: SeedanceProviderId): { configured: boolean } {
    return { configured: Boolean(this.key(providerId)) };
  }

  key(providerId: SeedanceProviderId): string | undefined {
    const value = this.#settings[KEY_FIELDS[providerId]];
    return typeof value === "string" ? value : undefined;
  }

  async update(providerId: SeedanceProviderId, value: string): Promise<{ configured: boolean }> {
    const normalized = value.trim();
    if (!normalized || !/^[\x21-\x7E]+$/.test(normalized)) throw new Error("API key must contain only printable ASCII characters");
    await this.#mutate(async () => {
      const next = { ...this.#settings, [KEY_FIELDS[providerId]]: normalized };
      await this.#persist(next);
      this.#settings = next;
    });
    return this.get(providerId);
  }

  async clear(providerId: SeedanceProviderId): Promise<void> {
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
      if (this.#unreadable) throw new Error("Seedance settings are unreadable; fix or update the file before changing settings");
      return operation();
    });
  }

  async #persist(settings: StoredSeedanceSettings): Promise<void> {
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
