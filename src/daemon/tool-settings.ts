import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolSettings } from "../shared/contracts.js";

interface StoredToolSettings extends ToolSettings {
  version: 1;
}

export class ToolSettingsStore {
  readonly #filePath: string;
  readonly #knownTools: Set<ToolDefinition["id"]>;
  #settings: ToolSettings = { enabledTools: [] };

  constructor(dataDirectory: string, knownTools: readonly ToolDefinition["id"][]) {
    this.#filePath = path.join(dataDirectory, "tool-settings.json");
    this.#knownTools = new Set(knownTools);
  }

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.#filePath, "utf8")) as unknown;
      if (!isStoredSettings(stored)) throw new Error(`Invalid tool settings: ${this.#filePath}`);
      this.#settings = { enabledTools: this.#validate(stored.enabledTools) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): ToolSettings {
    return { enabledTools: [...this.#settings.enabledTools] };
  }

  async update(enabledTools: readonly ToolDefinition["id"][]): Promise<ToolSettings> {
    const validated = this.#validate(enabledTools);
    if (sameTools(validated, this.#settings.enabledTools)) return this.get();
    const stored: StoredToolSettings = { version: 1, enabledTools: validated };
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
      await rename(temporary, this.#filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    this.#settings = { enabledTools: validated };
    return this.get();
  }

  #validate(values: readonly ToolDefinition["id"][]): ToolDefinition["id"][] {
    if (new Set(values).size !== values.length || values.some((id) => !this.#knownTools.has(id))) {
      throw new Error("Invalid enabled tools");
    }
    return [...values];
  }
}

function isStoredSettings(value: unknown): value is StoredToolSettings {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; enabledTools?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.enabledTools) &&
    candidate.enabledTools.every((id) => typeof id === "string");
}

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
