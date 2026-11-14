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
}

interface Stored {
  [key: string]: unknown;
  version: 1;
  providers: Record<string, Partial<Record<PluginMediaKind, PluginMediaModelChoice>>>;
}

export class PluginMediaModelChoiceError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

const EMPTY = (): Stored => ({ version: 1, providers: {} });

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
    const choice = this.#state.providers[providerId]?.[kind];
    return structuredClone({ added: (choice?.added ?? []) as Array<PluginMediaModels[K]>, hidden: choice?.hidden ?? [] });
  }

  /** Changes one provider's choice of one kind, one change at a time. */
  update<K extends PluginMediaKind>(providerId: string, kind: K, change: (choice: PluginMediaModelChoice<K>) => PluginMediaModelChoice<K>): Promise<void> {
    const run = this.#queue.then(async () => {
      await this.#load();
      if (this.#unreadable) throw new PluginMediaModelChoiceError(`${this.#unreadable} Fix or remove the file to change which models are on.`, 409);
      const next = change(await this.get(providerId, kind));
      const previous = this.#state.providers[providerId];
      const providers = { ...this.#state.providers, [providerId]: { ...previous, [kind]: { ...previous?.[kind], added: next.added, hidden: next.hidden } } };
      const text = JSON.stringify({ ...this.#state, providers }, null, 2);
      const state = parseStored(text);
      if (!state) throw new PluginMediaModelChoiceError("The updated model choices are invalid.");
      if (this.#file) {
        await mkdir(path.dirname(this.#file), { recursive: true });
        const temporary = `${this.#file}.${process.pid}.tmp`;
        await writeFile(temporary, `${text}\n`);
        await rename(temporary, this.#file);
      }
      this.#state = state;
    });
    this.#queue = run.catch(() => {});
    return run;
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
      const state = parseStored(text);
      if (state) this.#state = state;
      else this.#unreadable = `${this.#file} isn't a file this version of OhMyGame can read.`;
    })();
    return this.#loading;
  }
}

/** Preserve extensions verbatim; reject the whole store if any known choice cannot be read. */
function parseStored(text: string): Stored | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.providers)) return undefined;
  for (const kinds of Object.values(value.providers)) {
    if (!isRecord(kinds)) return undefined;
    for (const kind of PLUGIN_MEDIA_KINDS) {
      const choice = kinds[kind];
      if (choice === undefined) continue;
      if (!isRecord(choice) || !Array.isArray(choice.added) || !Array.isArray(choice.hidden) || !choice.hidden.every((id) => typeof id === "string")) return undefined;
      if (!choice.added.every((model) => pluginMediaModelProblem(kind, model) === undefined)) return undefined;
    }
  }
  return value as unknown as Stored;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
