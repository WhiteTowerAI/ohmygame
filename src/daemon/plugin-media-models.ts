import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_MEDIA_KINDS, pluginMediaModelProblem, type PluginMediaKind, type PluginMediaModels } from "../shared/plugin-manifest.js";

// Which media models of each plugin provider the person turned on or off in
// Settings (docs/media-provider-plugins.md). A model an adapter listed is kept
// whole once it's on, so it stays usable without listing the vendor's models
// again; a model the manifest lists is on unless turned off.

export interface PluginMediaModelChoice<K extends PluginMediaKind = PluginMediaKind> {
  /** Models the adapter listed that were turned on. */
  added: Array<PluginMediaModels[K]>;
  /** Ids of the manifest's models that were turned off. */
  hidden: string[];
  /** Manual 3D definitions and preset overrides, independent of discovery and visibility. */
  definitions?: Array<{ custom: boolean; model: PluginMediaModels["3d"] }>;
}

interface Stored {
  [key: string]: unknown;
  version: 2;
  providers: Record<string, Partial<Record<PluginMediaKind, PluginMediaModelChoice>>>;
}

export class PluginMediaModelChoiceError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const EMPTY = (): Stored => ({ version: 2, providers: {} });

export class PluginMediaModelChoices {
  readonly #file: string | undefined;
  #state: Stored = EMPTY();
  #loading: Promise<void> | undefined;
  /** Why the file couldn't be read: it is then never written over. */
  #unreadable: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  /** Without a data directory, choices last until the app closes. */
  constructor(dataDirectory?: string) {
    this.#file = dataDirectory ? path.join(dataDirectory, "plugin-media-models.json") : undefined;
  }

  async get<K extends PluginMediaKind>(providerId: string, kind: K): Promise<PluginMediaModelChoice<K>> {
    await this.#load();
    if (this.#unreadable) throw new PluginMediaModelChoiceError(this.#unreadable, 409);
    const choice = this.#state.providers[providerId]?.[kind];
    return structuredClone({ added: (choice?.added ?? []) as Array<PluginMediaModels[K]>, hidden: choice?.hidden ?? [], ...(kind === "3d" && choice?.definitions ? { definitions: choice.definitions } : {}) });
  }

  /** Changes one provider's choice of one kind, one change at a time. */
  update<K extends PluginMediaKind>(providerId: string, kind: K, change: (choice: PluginMediaModelChoice<K>) => PluginMediaModelChoice<K> | Promise<PluginMediaModelChoice<K>>): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#load();
      if (this.#unreadable) throw new PluginMediaModelChoiceError(`${this.#unreadable} Fix or remove the file to change which models are on.`, 409);
      const next = await change(await this.get(providerId, kind));
      if (kind !== "3d" && next.definitions !== undefined) throw new PluginMediaModelChoiceError("Only 3D model definitions can be edited");
      const previous = this.#state.providers[providerId];
      const providers = { ...this.#state.providers, [providerId]: { ...previous, [kind]: { ...previous?.[kind], added: next.added, hidden: next.hidden, ...(next.definitions ? { definitions: next.definitions } : {}) } } };
      const text = JSON.stringify({ ...this.#state, providers }, null, 2);
      const parsed = parseStored(text);
      if (!parsed) throw new PluginMediaModelChoiceError("The updated model choices are invalid.");
      await this.#write(text);
      this.#state = parsed.state;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(text: string): Promise<void> {
    if (!this.#file) return;
    await mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${text}\n`);
    await rename(temporary, this.#file);
  }

  #load(): Promise<void> {
    this.#loading ??= (async () => {
      if (!this.#file) return;
      let text: string;
      try {
        text = await readFile(this.#file, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        this.#unreadable = `${this.#file} can't be read.`;
        return;
      }
      const parsed = parseStored(text);
      if (parsed) {
        if (parsed.migrated) await this.#write(JSON.stringify(parsed.state, null, 2));
        this.#state = parsed.state;
      } else this.#unreadable = `${this.#file} isn't a file this version of OhMyGame can read.`;
    })();
    return this.#loading;
  }
}

/** Preserve extensions verbatim; reject the whole store if any known choice cannot be read. */
function parseStored(text: string): { state: Stored; migrated: boolean } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !isRecord(value.providers)) return undefined;
  for (const kinds of Object.values(value.providers)) {
    if (!isRecord(kinds)) return undefined;
    for (const kind of PLUGIN_MEDIA_KINDS) {
      const choice = kinds[kind];
      if (choice === undefined) continue;
      if (!isRecord(choice) || !Array.isArray(choice.added) || !Array.isArray(choice.hidden) || !choice.hidden.every((id) => typeof id === "string")) return undefined;
      if (!choice.added.every((model) => pluginMediaModelProblem(kind, model) === undefined)) return undefined;
      if (kind === "3d" && choice.definitions !== undefined) {
        // Version 1 did not own this key: never reinterpret or overwrite an extension.
        if (value.version === 1 || !Array.isArray(choice.definitions) || choice.definitions.length > 2000) return undefined;
        const ids = new Set<string>();
        for (const definition of choice.definitions) {
          if (!isRecord(definition) || Object.keys(definition).some(key => key !== "custom" && key !== "model") || typeof definition.custom !== "boolean" || pluginMediaModelProblem("3d", definition.model) !== undefined) return undefined;
          const id = (definition.model as PluginMediaModels["3d"]).id;
          if (ids.has(id)) return undefined;
          ids.add(id);
        }
      }
    }
  }
  // compat: since beta.5.7, remove from beta.7 and 2026-12-14. V1 predates manual model definitions.
  // The shape is additive; preserve every extension while marking the newly owned definitions key.
  return { state: { ...value, version: 2 } as unknown as Stored, migrated: value.version === 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
