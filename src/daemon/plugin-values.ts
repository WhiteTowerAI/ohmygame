import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginConfigurationValues } from "../shared/extension-host-protocol.js";
import { configReferences, fillConfigReferences, mcpUrlIssue } from "../shared/plugin-manifest.js";
import type { PluginIndexEntry } from "./plugin-index.js";

// The person's values for plugins' `configuration` fields, one file
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
  /** The file holds values in a form this version can't read, such as a newer version's, so writing would lose them. */
  #unreadable = false;
  #metadata: Record<string, unknown> = {};
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Whether loading found data that an update would lose. */
  get readOnly(): boolean { return this.#unreadable; }

  /** App-owned migration inspection without an installed manifest. Never send this to a plugin or the renderer. */
  storedSecret(id: string, name: string): { occupied: boolean; value?: string } {
    const fields = this.#values[id] ?? {};
    const stored = fields[name];
    return {
      occupied: Object.hasOwn(fields, name),
      value: stored?.type === "secret" && typeof stored.value === "string" ? stored.value : undefined,
    };
  }

  async load(): Promise<void> {
    this.#unreadable = true;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.#values = {};
      this.#metadata = {};
      this.#unreadable = false;
      return;
    }
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.version !== 1 || !record(value.plugins)) return;
    const plugins: Stored = Object.create(null);
    let unreadable = false;
    for (const [id, fields] of Object.entries(value.plugins)) {
      if (!record(fields)) { unreadable = true; continue; }
      const entries: Record<string, StoredValue> = Object.create(null);
      for (const [name, stored] of Object.entries(fields)) {
        if (!record(stored) || !FIELD_TYPES.has(String(stored.type)) ||
          (stored.type === "boolean" ? typeof stored.value !== "boolean" : typeof stored.value !== "string")) {
          unreadable = true;
          continue;
        }
        // Keep extension metadata, including fields this app does not interpret.
        entries[name] = stored as unknown as StoredValue;
      }
      plugins[id] = entries;
    }
    this.#values = plugins;
    const { plugins: _plugins, ...metadata } = value;
    this.#metadata = metadata;
    this.#unreadable = unreadable;
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

  /**
   * A secret field's value, for the app's own use, such as the key of a
   * model provider the plugin adds. The plugin's code never gets it this way.
   */
  secret(entry: PluginIndexEntry, name: string): string | undefined {
    const field = entry.manifest.configuration?.[name];
    const value = field?.type === "secret" ? this.#value(entry, name, field) : undefined;
    return typeof value === "string" && value ? value : undefined;
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
    expected?: PluginConfigurationValues,
  ): Promise<void> {
    if (this.#unreadable) throw new PluginConfigurationError(`Plugin settings in ${this.file} were saved by a newer OhMyGame or are damaged. Update OhMyGame, or fix or remove the file.`);
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
      if (expected) {
        const actual = this.forNative(entry);
        const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
        if ([...keys].some((key) => actual[key] !== expected[key])) throw new PluginConfigurationError("Plugin settings changed; start the connection again");
      }
      const next = { ...values[entry.id] };
      for (const [name, value] of Object.entries(changes))
        if (value === null) delete next[name];
        else
          next[name] = {
            ...next[name],
            type: fields[name]!.type,
            value: typeof value === "string" ? value.trim() : value,
          };
      return { ...values, [entry.id]: next };
    });
  }

  /** A plugin's saved secrets, so what is shown of its log leaves them out. */
  secrets(id: string): string[] {
    return Object.values(this.#values[id] ?? {}).flatMap((stored) => stored.type === "secret" && typeof stored.value === "string" ? [stored.value] : []);
  }

  /** How many values are saved for a plugin, for what uninstalling it removes. */
  count(id: string): number {
    return Object.keys(this.#values[id] ?? {}).length;
  }

  /** Removes a plugin's values, as when its last version is uninstalled. */
  forget(id: string): Promise<void> {
    // Values it can't read stay as they are rather than be lost with the rest of the file.
    if (this.#unreadable) return Promise.resolve();
    return this.#write((values) => {
      const { [id]: _removed, ...rest } = values;
      return rest;
    });
  }

  #write(change: (values: Stored) => Stored): Promise<void> {
    const next = this.#queue.catch(() => {}).then(async () => {
      if (this.#unreadable) throw new PluginConfigurationError("Plugin settings are unreadable; fix or update the file before changing settings");
      const values = change(this.#values);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ ...this.#metadata, version: 1, plugins: values }, null, 2)}\n`,
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
