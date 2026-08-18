import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolSettings } from "../shared/contracts.js";

interface StoredToolSettings extends ToolSettings {
  version: 2;
}

export class InvalidToolSettingsError extends Error {}

export class ToolSettingsStore {
  readonly #filePath: string;
  readonly #knownTools: Set<ToolDefinition["id"]>;
  #settings: ToolSettings = { installedTools: [], enabledTools: [] };

  constructor(dataDirectory: string, knownTools: readonly ToolDefinition["id"][]) {
    this.#filePath = path.join(dataDirectory, "tool-settings.json");
    this.#knownTools = new Set(knownTools);
  }

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (isStoredSettingsV2(stored)) {
        this.#settings = this.#validateSettings(stored.installedTools, stored.enabledTools);
      } else if (isStoredSettingsV1(stored)) {
        const tools = this.#validate(stored.enabledTools as ToolDefinition["id"][]);
        this.#settings = { installedTools: tools, enabledTools: tools };
        await this.#write(this.#settings);
      } else {
        throw new Error(`Invalid tool settings: ${this.#filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): ToolSettings {
    return {
      installedTools: [...this.#settings.installedTools],
      enabledTools: [...this.#settings.enabledTools],
    };
  }

  async update(settings: ToolSettings): Promise<ToolSettings> {
    const next = this.#validateSettings(settings.installedTools, settings.enabledTools);
    if (sameSettings(next, this.#settings)) return this.get();
    await this.#write(next);
    this.#settings = next;
    return this.get();
  }

  #validateSettings(installedTools: readonly ToolDefinition["id"][], enabledTools: readonly ToolDefinition["id"][]): ToolSettings {
    const installed = this.#validate(installedTools);
    const enabled = this.#validate(enabledTools);
    if (enabled.some((id) => !installed.includes(id))) throw new InvalidToolSettingsError("Enabled tools must be installed");
    return { installedTools: installed, enabledTools: enabled };
  }

  async #write(settings: ToolSettings): Promise<void> {
    const stored: StoredToolSettings = { version: 2, ...settings };
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      await rename(temporary, this.#filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #validate(values: readonly ToolDefinition["id"][]): ToolDefinition["id"][] {
    if (new Set(values).size !== values.length || values.some((id) => !this.#knownTools.has(id))) {
      throw new InvalidToolSettingsError("Invalid tool settings");
    }
    return [...values];
  }
}

function isStoredSettingsV2(value: unknown): value is StoredToolSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; installedTools?: unknown; enabledTools?: unknown };
  return candidate.version === 2 && Array.isArray(candidate.installedTools) && Array.isArray(candidate.enabledTools) &&
    candidate.installedTools.every((id) => typeof id === "string") && candidate.enabledTools.every((id) => typeof id === "string");
}

function isStoredSettingsV1(value: unknown): value is { version: 1; enabledTools: string[] } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; enabledTools?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.enabledTools) && candidate.enabledTools.every((id) => typeof id === "string");
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSettings(left: ToolSettings, right: ToolSettings): boolean {
  return sameTools(left.installedTools, right.installedTools) && sameTools(left.enabledTools, right.enabledTools);
}
