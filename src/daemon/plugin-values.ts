import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginConfigurationValues } from "../shared/extension-host-protocol.js";
import { configReferences, fillConfigReferences, mcpUrlIssue } from "../shared/plugin-manifest.js";
import type { PluginIndexEntry } from "./plugin-index.js";

// The person's values for format 2 plugins' `configuration` fields, one file
// for every plugin, readable only by the person (it holds secrets). Values
// are app-wide, like an engine's path or an account key. The renderer never
// gets a secret back, only whether one is set; native code gets secrets
// only when its manifest declares `capabilities.secrets`. Each value keeps
// the type of the field it was set for: a version that declares the field
// with another type doesn't see it, so a secret never becomes plain text.

/** Longer values are refused; a path or a key is never this long. */
const VALUE_MAX_CHARS = 4096;

type Field = NonNullable<PluginIndexEntry["manifest"]["configuration"]>[string];

/** What a settings page shows for one field. */
export type PluginConfigurationView = Record<
  string,
  | { type: Exclude<Field["type"], "secret">; value: string | boolean | null }
  | { type: "secret"; configured: boolean }
>;

export class PluginConfigurationError extends Error {
  readonly statusCode = 400;
}

interface StoredValue {
  type: Field["type"];
  value: string | boolean;
}

type Stored = Record<string, Record<string, StoredValue>>;

const FIELD_TYPES = new Set(["text", "secret", "path", "boolean", "select"]);

export class PluginValues {
  #values: Stored = {};
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const value = JSON.parse(text) as { version?: unknown; plugins?: unknown };
    if (value.version !== 1 || !value.plugins || typeof value.plugins !== "object")
      return;
    const plugins: Stored = {};
    for (const [id, fields] of Object.entries(value.plugins as Record<string, unknown>)) {
      if (!fields || typeof fields !== "object") continue;
      plugins[id] = Object.fromEntries(
        Object.entries(fields as Record<string, Partial<StoredValue>>).filter(
          (entry): entry is [string, StoredValue] =>
            FIELD_TYPES.has(String(entry[1]?.type)) &&
            (typeof entry[1]?.value === "string" || typeof entry[1]?.value === "boolean"),
        ),
      );
    }
    this.#values = plugins;
  }

  /** What a call to the plugin's native code carries, defaults filled in. */
  forNative(entry: PluginIndexEntry): PluginConfigurationValues {
    const secrets = entry.manifest.capabilities?.secrets === true;
    const values: PluginConfigurationValues = {};
    for (const [name, field] of Object.entries(entry.manifest.configuration ?? {})) {
      if (field.type === "secret" && !secrets) continue;
      const value = this.#value(entry, name, field) ?? field.default;
      if (value !== undefined) values[name] = value;
    }
    return values;
  }

  /** A stored value, only when it was set for a field of this type and still fits it. */
  #value(entry: PluginIndexEntry, name: string, field: Field) {
    const stored = this.#values[entry.id]?.[name];
    return stored && stored.type === field.type && !invalid(field, stored.value)
      ? stored.value
      : undefined;
  }

  /** Whether the person set a field, rather than it falling back to its default. */
  isSet(entry: PluginIndexEntry, name: string): boolean {
    const field = entry.manifest.configuration?.[name];
    return field !== undefined && this.#value(entry, name, field) !== undefined;
  }

  /** What the plugin's settings page shows; secrets only say whether they are set. */
  view(entry: PluginIndexEntry): PluginConfigurationView {
    return Object.fromEntries(
      Object.entries(entry.manifest.configuration ?? {}).map(([name, field]) => [
        name,
        field.type === "secret"
          ? { type: "secret" as const, configured: this.#value(entry, name, field) !== undefined }
          : { type: field.type, value: this.#value(entry, name, field) ?? field.default ?? null },
      ]),
    );
  }

  /**
   * Sets some fields; `null` clears one back to its default. Every value is
   * checked against its field first, so a bad value changes nothing.
   */
  update(
    entry: PluginIndexEntry,
    changes: Record<string, string | boolean | null>,
  ): Promise<void> {
    const fields = entry.manifest.configuration ?? {};
    for (const [name, value] of Object.entries(changes)) {
      const field = fields[name];
      if (!field) throw new PluginConfigurationError(`${entry.id} has no setting ${name}`);
      if (value === null) continue;
      const problem = invalid(field, value);
      if (problem) throw new PluginConfigurationError(`${name} ${problem}`);
    }
    // An HTTP MCP server's URL, once these values fill it in, must still be allowed.
    const next: Record<string, unknown> = { ...this.forNative(entry) };
    for (const [name, value] of Object.entries(changes)) next[name] = value === null ? fields[name]!.default : typeof value === "string" ? value.trim() : value;
    for (const server of entry.manifest.contributes?.mcpServers ?? []) {
      if (!("url" in server)) continue;
      const names = configReferences(server.url);
      if (!names.some((name) => name in changes) || names.some((name) => next[name] === undefined)) continue;
      const url = fillConfigReferences(server.url, next);
      const problem = mcpUrlIssue(url, entry.manifest.capabilities?.network);
      if (problem) throw new PluginConfigurationError(`${url} ${problem}`);
    }
    return this.#write((values) => {
      const next = { ...values[entry.id] };
      for (const [name, value] of Object.entries(changes))
        if (value === null) delete next[name];
        else
          next[name] = {
            type: fields[name]!.type,
            value: typeof value === "string" ? value.trim() : value,
          };
      return { ...values, [entry.id]: next };
    });
  }

  /** Removes a plugin's values, as when its last version is uninstalled. */
  forget(id: string): Promise<void> {
    return this.#write((values) => {
      const { [id]: _removed, ...rest } = values;
      return rest;
    });
  }

  #write(change: (values: Stored) => Stored): Promise<void> {
    const next = this.#queue.catch(() => {}).then(async () => {
      const values = change(this.#values);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, plugins: values }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporary, this.file);
      // Published only once it is on disk.
      this.#values = values;
    });
    this.#queue = next;
    return next;
  }
}

function invalid(field: Field, value: string | boolean): string | undefined {
  if (field.type === "boolean")
    return typeof value === "boolean" ? undefined : "must be true or false";
  if (typeof value !== "string") return "must be text";
  if (value.length > VALUE_MAX_CHARS) return `is longer than ${VALUE_MAX_CHARS} characters`;
  if (/[\u0000-\u001f]/.test(value)) return "has control characters";
  if (field.type === "select" && !field.options?.includes(value))
    return `must be one of ${field.options?.join(", ")}`;
  if (field.type === "path" && value.trim() && !path.isAbsolute(value.trim()))
    return "must be an absolute path";
  return undefined;
}
