import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUDIO_VOICE_ID_MAX_LENGTH, AUDIO_VOICE_ID_PATTERN } from "../shared/audio.js";

interface StoredGptSovitsSettings {
  version: 1;
  baseUrl?: string;
  token?: string;
  defaultVoiceId?: string;
}

/** Accepts a daemon-style base URL such as `http://192.0.2.10:9880` and strips its trailing slash. */
export function normalizeGptSovitsBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Base URL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (url.search || url.hash) throw new Error("Base URL must not include a query or fragment");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function voiceId(value: unknown): string | undefined {
  return typeof value === "string" && new RegExp(AUDIO_VOICE_ID_PATTERN).test(value) && value.length <= AUDIO_VOICE_ID_MAX_LENGTH
    ? value
    : undefined;
}

/** Settings for the self-hosted GPT-SoVITS audio provider: gateway base URL, optional X-GSV-Token and default voice. */
export class GptSovitsSettingsStore {
  readonly #filePath: string;
  #settings: StoredGptSovitsSettings = { version: 1 };
  #mutations: Promise<void> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "gpt-sovits.json");
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Record<string, unknown>;
      if (parsed.version !== 1) throw new Error(`Invalid GPT-SoVITS settings: ${this.#filePath}`);
      this.#settings = {
        version: 1,
        ...(typeof parsed.baseUrl === "string" && parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
        ...(typeof parsed.token === "string" && parsed.token ? { token: parsed.token } : {}),
        ...(voiceId(parsed.defaultVoiceId) ? { defaultVoiceId: voiceId(parsed.defaultVoiceId) } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): { configured: boolean; tokenConfigured: boolean; baseUrl?: string; defaultVoiceId?: string } {
    return {
      configured: Boolean(this.#settings.baseUrl),
      tokenConfigured: Boolean(this.#settings.token),
      ...(this.#settings.baseUrl ? { baseUrl: this.#settings.baseUrl } : {}),
      ...(this.#settings.defaultVoiceId ? { defaultVoiceId: this.#settings.defaultVoiceId } : {}),
    };
  }

  baseUrl(): string | undefined {
    return this.#settings.baseUrl;
  }

  token(): string | undefined {
    return this.#settings.token;
  }

  defaultVoiceId(): string | undefined {
    return this.#settings.defaultVoiceId;
  }

  async update(changes: { baseUrl?: string; token?: string | null; defaultVoiceId?: string | null }): Promise<void> {
    await this.#mutate(async () => {
      const next: StoredGptSovitsSettings = { ...this.#settings };
      if (changes.baseUrl !== undefined) {
        next.baseUrl = changes.baseUrl ? normalizeGptSovitsBaseUrl(changes.baseUrl) : undefined;
      }
      if (changes.token !== undefined) {
        const normalized = changes.token?.trim();
        if (normalized && !/^[\x21-\x7E]+$/.test(normalized)) throw new Error("Token must contain only printable ASCII characters");
        next.token = normalized || undefined;
      }
      if (changes.defaultVoiceId !== undefined) {
        const normalized = changes.defaultVoiceId?.trim() || undefined;
        if (normalized && !new RegExp(AUDIO_VOICE_ID_PATTERN).test(normalized)) throw new Error("Default voice ID contains unsupported characters");
        next.defaultVoiceId = normalized;
      }
      await this.#persist(next);
      this.#settings = next;
    });
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

  async #persist(settings: StoredGptSovitsSettings): Promise<void> {
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
