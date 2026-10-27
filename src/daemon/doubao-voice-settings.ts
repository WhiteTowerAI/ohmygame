import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AUDIO_VOICE_ID_MAX_LENGTH,
  AUDIO_VOICE_ID_PATTERN,
} from "../shared/audio.js";

export type DoubaoService = "volcengine-tts" | "volcengine-seed-audio";
interface Settings {
  version: 1;
  /** Shared by both services unless a service has its own entry. */
  apiKey?: string;
  /** A string overrides the shared key; null disconnects that service. */
  services: Partial<Record<DoubaoService, string | null>>;
  defaultVoiceId?: string;
}
export interface DoubaoVoiceConnection {
  ttsConfigured: boolean;
  seedConfigured: boolean;
  distinctKeys: boolean;
  defaultVoiceId?: string;
}

// Files written by the separate stores this one replaces.
const LEGACY_FILES: Record<DoubaoService, string> = {
  "volcengine-tts": "volcengine-tts.json",
  "volcengine-seed-audio": "volcengine-seed-audio.json",
};

/** One Doubao Voice connection for speech synthesis and Seed Audio. */
export class DoubaoVoiceSettingsStore {
  #settings: Settings = { version: 1, services: {} };
  #mutations = Promise.resolve();
  readonly #directory: string;
  readonly #file: string;
  constructor(directory: string) {
    this.#directory = directory;
    this.#file = path.join(directory, "doubao-voice.json");
  }

  async load(): Promise<void> {
    const current = await readSettings(this.#file);
    if (current) {
      if (
        current.version !== 1 ||
        !current.services ||
        typeof current.services !== "object"
      )
        throw new Error("Invalid Doubao Voice settings");
      this.#settings = current as unknown as Settings;
    }
    const tts = await readSettings(this.#legacy("volcengine-tts"));
    const seed = await readSettings(this.#legacy("volcengine-seed-audio"));
    if (!tts && !seed) return;
    const ttsKey = stringValue(tts?.apiKey),
      seedKey = stringValue(seed?.apiKey);
    const defaultVoiceId =
      this.#settings.defaultVoiceId ?? stringValue(tts?.defaultVoiceId);
    // An equal pair becomes the shared key; otherwise each key stays with its service.
    const migrated: Settings = current
      ? this.#settings
      : ttsKey && ttsKey === seedKey
        ? { version: 1, apiKey: ttsKey, services: {} }
        : {
            version: 1,
            services: {
              ...(ttsKey ? { "volcengine-tts": ttsKey } : {}),
              ...(seedKey ? { "volcengine-seed-audio": seedKey } : {}),
            },
          };
    await this.#mutate(() =>
      defaultVoiceId ? { ...migrated, defaultVoiceId } : migrated,
    );
    await Promise.all(
      (Object.keys(LEGACY_FILES) as DoubaoService[]).map((service) =>
        rm(this.#legacy(service), { force: true }),
      ),
    );
  }

  key(service: DoubaoService): string | undefined {
    const value = this.#settings.services[service];
    return value === null ? undefined : (value ?? this.#settings.apiKey);
  }
  defaultVoiceId(): string | undefined {
    return this.#settings.defaultVoiceId;
  }
  get(): DoubaoVoiceConnection {
    const tts = this.key("volcengine-tts"),
      seed = this.key("volcengine-seed-audio");
    return {
      ttsConfigured: Boolean(tts),
      seedConfigured: Boolean(seed),
      distinctKeys: Boolean(tts && seed && tts !== seed),
      ...(this.#settings.defaultVoiceId
        ? { defaultVoiceId: this.#settings.defaultVoiceId }
        : {}),
    };
  }

  /** Connects both services with one key, replacing per-service keys. */
  async update(key: string): Promise<void> {
    const apiKey = validateKey(key);
    await this.#mutate(() => ({ ...this.#settings, apiKey, services: {} }));
  }
  async setService(service: DoubaoService, key: string | null): Promise<void> {
    const value = key === null ? null : validateKey(key);
    await this.#mutate(() => ({
      ...this.#settings,
      services: { ...this.#settings.services, [service]: value },
    }));
  }
  async setDefaultVoice(voiceId: string | null): Promise<void> {
    const value = voiceId?.trim() || undefined;
    if (
      voiceId !== null &&
      (!value ||
        value.length > AUDIO_VOICE_ID_MAX_LENGTH ||
        !new RegExp(AUDIO_VOICE_ID_PATTERN).test(value))
    )
      throw new Error("Doubao Speaker ID is invalid");
    if (value && !this.key("volcengine-tts"))
      throw new Error(
        "Connect Doubao speech synthesis before choosing a voice",
      );
    await this.#mutate(() => {
      const { defaultVoiceId: _, ...settings } = this.#settings;
      return value ? { ...settings, defaultVoiceId: value } : settings;
    });
  }

  #legacy(service: DoubaoService): string {
    return path.join(this.#directory, LEGACY_FILES[service]);
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

function validateKey(key: string): string {
  const value = key.trim();
  if (!value || !/^[\x21-\x7E]+$/.test(value))
    throw new Error(
      "Doubao API key must contain printable ASCII characters only",
    );
  return value;
}

async function readSettings(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Invalid Doubao Voice settings: ${file}`);
    return value as Record<string, unknown>;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
