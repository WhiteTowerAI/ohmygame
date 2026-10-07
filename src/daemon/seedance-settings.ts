import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SeedanceProviderId } from "./seedance-models.js";

interface StoredSeedanceSettings {
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
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "seedance.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1) throw new Error(`Invalid Seedance settings: ${this.#filePath}`);
      this.#settings = {
        version: 1,
        ...apiKey("volcengineApiKey", parsed.volcengineApiKey),
        ...apiKey("byteplusApiKey", parsed.byteplusApiKey),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
      this.#settings = { ...this.#settings, [KEY_FIELDS[providerId]]: normalized };
      await this.#persist();
    });
    return this.get(providerId);
  }

  async clear(providerId: SeedanceProviderId): Promise<void> {
    await this.#mutate(async () => {
      const next = { ...this.#settings };
      delete next[KEY_FIELDS[providerId]];
      this.#settings = next;
      if (!this.key("volcengine-ark") && !this.key("byteplus-modelark")) {
        await rm(this.#filePath, { force: true });
      } else {
        await this.#persist();
      }
    });
  }

  async #mutate(operation: () => Promise<void>): Promise<void> {
    const pending = this.#mutations.then(operation);
    this.#mutations = pending.catch(() => undefined);
    await pending;
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(this.#settings)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function apiKey<Key extends "volcengineApiKey" | "byteplusApiKey">(
  key: Key,
  value: unknown,
): Partial<Pick<StoredSeedanceSettings, Key>> {
  return typeof value === "string" && value ? { [key]: value } as Pick<StoredSeedanceSettings, Key> : {};
}
