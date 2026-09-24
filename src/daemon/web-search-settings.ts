import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  UpdateWebSearchSettings,
  WebSearchProvider,
  WebSearchSettings,
} from "../shared/web-search.js";

export interface StoredWebSearchSettings {
  version: 1;
  enabled: boolean;
  provider: WebSearchProvider;
  fallback: boolean;
  exaApiKey?: string;
  parallelApiKey?: string;
  custom?: {
    name: string;
    endpoint: string;
    toolName: string;
    apiKey?: string;
  };
}

const DEFAULT_SETTINGS: StoredWebSearchSettings = {
  version: 1,
  enabled: true,
  provider: "auto",
  fallback: true,
};

export class WebSearchSettingsStore {
  readonly #filePath: string;
  #settings: StoredWebSearchSettings = { ...DEFAULT_SETTINGS };

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "web-search-settings.json");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(
        await readFile(this.#filePath, "utf8"),
      ) as unknown;
      if (!isStoredSettings(value))
        throw new Error(`Invalid web search settings: ${this.#filePath}`);
      this.#settings = cloneStored(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): WebSearchSettings {
    const value = this.#settings;
    return {
      enabled: value.enabled,
      provider: value.provider,
      fallback: value.fallback,
      exaApiKeyConfigured: Boolean(value.exaApiKey),
      parallelApiKeyConfigured: Boolean(value.parallelApiKey),
      ...(value.custom
        ? {
            custom: {
              name: value.custom.name,
              endpoint: value.custom.endpoint,
              toolName: value.custom.toolName,
              apiKeyConfigured: Boolean(value.custom.apiKey),
            },
          }
        : {}),
    };
  }

  runtime(): StoredWebSearchSettings {
    return cloneStored(this.#settings);
  }

  async update(input: UpdateWebSearchSettings): Promise<WebSearchSettings> {
    const custom = input.custom
      ? {
          name: required(input.custom.name, "Custom provider name"),
          endpoint: normalizedEndpoint(input.custom.endpoint),
          toolName: required(input.custom.toolName, "Custom MCP tool name"),
          ...secretUpdate(input.custom.apiKey, this.#settings.custom?.apiKey),
        }
      : this.#settings.custom
        ? { ...this.#settings.custom }
        : undefined;
    if (input.provider === "custom" && !custom)
      throw new Error("Custom provider configuration is required");
    const next: StoredWebSearchSettings = {
      version: 1,
      enabled: input.enabled,
      provider: input.provider,
      fallback: input.fallback,
      ...secretField("exaApiKey", input.exaApiKey, this.#settings.exaApiKey),
      ...secretField(
        "parallelApiKey",
        input.parallelApiKey,
        this.#settings.parallelApiKey,
      ),
      ...(custom ? { custom } : {}),
    };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#filePath);
    this.#settings = cloneStored(next);
    return this.get();
  }
}

function secretField<K extends "exaApiKey" | "parallelApiKey">(
  key: K,
  update: string | null | undefined,
  current: string | undefined,
): Partial<Pick<StoredWebSearchSettings, K>> {
  const value = updatedSecret(update, current);
  return value ? ({ [key]: value } as Pick<StoredWebSearchSettings, K>) : {};
}

function secretUpdate(
  update: string | null | undefined,
  current: string | undefined,
): { apiKey?: string } {
  const value = updatedSecret(update, current);
  return value ? { apiKey: value } : {};
}

function updatedSecret(
  update: string | null | undefined,
  current: string | undefined,
): string | undefined {
  if (update === undefined) return current;
  if (update === null) return undefined;
  return update.trim() || undefined;
}

function normalizedEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    throw new Error("Custom MCP endpoint is not valid");
  }
  if (
    !/^https?:$/.test(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new Error("Custom MCP endpoint is not valid");
  }
  return endpoint.toString();
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function cloneStored(value: StoredWebSearchSettings): StoredWebSearchSettings {
  return {
    ...value,
    ...(value.custom ? { custom: { ...value.custom } } : {}),
  };
}

function isStoredSettings(value: unknown): value is StoredWebSearchSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredWebSearchSettings>;
  if (
    candidate.version !== 1 ||
    typeof candidate.enabled !== "boolean" ||
    typeof candidate.fallback !== "boolean"
  )
    return false;
  if (
    !candidate.provider ||
    !["auto", "exa", "parallel", "custom"].includes(candidate.provider)
  )
    return false;
  if (
    candidate.exaApiKey !== undefined &&
    typeof candidate.exaApiKey !== "string"
  )
    return false;
  if (
    candidate.parallelApiKey !== undefined &&
    typeof candidate.parallelApiKey !== "string"
  )
    return false;
  if (candidate.custom === undefined) return candidate.provider !== "custom";
  return (
    typeof candidate.custom.name === "string" &&
    Boolean(candidate.custom.name.trim()) &&
    typeof candidate.custom.endpoint === "string" &&
    Boolean(candidate.custom.endpoint) &&
    typeof candidate.custom.toolName === "string" &&
    Boolean(candidate.custom.toolName.trim()) &&
    (candidate.custom.apiKey === undefined ||
      typeof candidate.custom.apiKey === "string")
  );
}
