import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import { GAME_TUNING_FILES, gameTuningValue, type GameTuningItem, type GameTuningScalar, type GameTuningState } from "../shared/game-tuning.js";

// The file is the only lasting copy of the values. A draft lives here, not in
// the page, so that it survives the game restarting and reaches every page of
// the game. Pages only ever receive ids and values; nothing a page says is
// stored, apart from the fact that it is listening.

const MAX_FILE_BYTES = 256 * 1024;
const MAX_VALUES = 100;
const MAX_LABEL = 80;
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;

type Project = Pick<ProjectState, "id" | "workspacePath">;
type TuningDocument = { values: Record<string, unknown>[] } & Record<string, unknown>;

/** Reads the values out of a tuning file, or says what is wrong with it. */
export function parseGameTuning(text: string): { document: TuningDocument; values: GameTuningItem[] } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new Error(`It isn't valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("It must be a JSON object.");
  const { schemaVersion, values } = document as Record<string, unknown>;
  if (schemaVersion !== 1) throw new Error('"schemaVersion" must be 1.');
  if (!Array.isArray(values)) throw new Error('"values" must be a list.');
  if (values.length > MAX_VALUES) throw new Error(`"values" can hold at most ${MAX_VALUES} entries.`);
  const seen = new Set<string>();
  const items = values.map((raw: unknown, index): GameTuningItem => {
    const at = `values[${index}]`;
    if (!raw || typeof raw !== "object") throw new Error(`${at} must be an object.`);
    const { id, label, value, min, max, step } = raw as Record<string, unknown>;
    if (typeof id !== "string" || !ID.test(id)) throw new Error(`${at}.id must start with a letter and use only letters, digits, ".", "_" and "-".`);
    if (seen.has(id)) throw new Error(`The id "${id}" is used twice.`);
    seen.add(id);
    if (typeof label !== "string" || !label.trim() || label.length > MAX_LABEL) throw new Error(`"${id}" needs a label of at most ${MAX_LABEL} characters.`);
    if (typeof value === "boolean") return { id, label, value };
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${id}" needs a value that is a number or true or false.`);
    if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || min >= max)
      throw new Error(`"${id}" needs a "min" below its "max".`);
    if (value < min || value > max) throw new Error(`"${id}" has the value ${value}, outside ${min} to ${max}.`);
    if (step !== undefined && (typeof step !== "number" || !Number.isFinite(step) || step <= 0)) throw new Error(`"${id}" needs a "step" above 0.`);
    return { id, label, value, min, max, ...(step === undefined ? {} : { step }) };
  });
  return { document: document as TuningDocument, values: items };
}

type Read = { file?: string; document?: TuningDocument; values: GameTuningItem[]; error?: string };

async function readGameTuning(project: Project): Promise<Read> {
  for (const file of GAME_TUNING_FILES) {
    const absolute = path.join(project.workspacePath, file);
    try {
      // The project's own file only: a link could read or overwrite anything.
      const stats = await lstat(absolute);
      if (!stats.isFile()) return { file, values: [], error: "It must be a regular file, not a link or a folder." };
      if (stats.size > MAX_FILE_BYTES) return { file, values: [], error: `It is larger than ${MAX_FILE_BYTES / 1024} KiB.` };
      const [root, real] = await Promise.all([realpath(project.workspacePath), realpath(absolute)]);
      if (!real.startsWith(root + path.sep)) return { file, values: [], error: "It must be inside the project." };
      return { file, ...parseGameTuning(await readFile(absolute, "utf8")) };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { file, values: [], error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return { values: [] };
}

function clamped(item: GameTuningItem, value: GameTuningScalar): GameTuningScalar | undefined {
  if (typeof item.value !== typeof value) return undefined;
  return "min" in item ? Math.min(item.max, Math.max(item.min, value as number)) : value;
}

interface Entry {
  loaded: boolean;
  file?: string;
  values: GameTuningItem[];
  draft: Map<string, GameTuningScalar>;
  error?: string;
  connected: boolean;
  queue: Promise<unknown>;
  sequence: number;
  published?: string;
  /** While a save runs, what each moved value should end up as. */
  moved?: Map<string, GameTuningScalar>;
}

export class GameTuning {
  #entries = new Map<string, Entry>();
  // From the clock, so that it keeps rising when the daemon restarts.
  #sequence = Date.now();

  constructor(
    private readonly options: {
      /** Gives the running game every value it should use. */
      push: (project: Project, values: Record<string, GameTuningScalar>) => void;
      publish: (project: Project, state: GameTuningState) => void;
    },
  ) {}

  /** What the file says now, with the changes not saved yet. */
  async state(project: Project): Promise<GameTuningState> {
    await this.refresh(project);
    return this.#snapshot(this.#entry(project));
  }

  /** Reads the file again and passes on what changed. */
  refresh(project: Project): Promise<void> {
    return this.#queued(project, async (entry) => {
      this.#apply(entry, await readGameTuning(project));
      this.#announce(project, entry);
    });
  }

  /** Changes values without saving them; null goes back to what is saved. */
  async setDraft(project: Project, changes: Record<string, GameTuningScalar | null>): Promise<GameTuningState> {
    const entry = this.#entry(project);
    if (!entry.loaded) await this.refresh(project);
    for (const [id, change] of Object.entries(changes)) {
      const item = entry.values.find((candidate) => candidate.id === id);
      const value = change === null || !item ? undefined : clamped(item, change);
      if (value === undefined || value === item?.value) entry.draft.delete(id);
      else entry.draft.set(id, value);
      if (item) entry.moved?.set(id, value ?? item.value);
    }
    this.#announce(project, entry);
    return this.#snapshot(entry);
  }

  /**
   * Writes the draft to the file, through `write` so it can become an undoable
   * change. A value moved while this ran stays a draft.
   */
  save<R>(project: Project, write: (operation: () => Promise<void>) => Promise<R>): Promise<R> {
    return this.#queued(project, async (entry) => {
      const saved = new Map(entry.draft);
      const moved = (entry.moved = new Map<string, GameTuningScalar>());
      let read: Read | undefined;
      let result: R;
      try {
        result = await write(async () => {
          read = await readGameTuning(project);
          if (read.error || !read.file || !read.document) throw new GameTuningError(read.error ?? "There is no tuning file.");
          // The file may have changed since the value was moved, as its range can.
          read.values = read.values.map((item, index) => {
            const draft = saved.get(item.id);
            const value = draft === undefined ? undefined : clamped(item, draft);
            if (value === undefined) return item;
            read!.document!.values[index].value = value;
            return { ...item, value } as GameTuningItem;
          });
          const content = `${JSON.stringify(read.document, null, 2)}\n`;
          if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new GameTuningError(`Saved, it would be larger than ${MAX_FILE_BYTES / 1024} KiB.`);
          await writeBeside(path.join(project.workspacePath, read.file), content);
        });
      } finally {
        entry.moved = undefined;
      }
      if (read) {
        for (const id of saved.keys()) entry.draft.delete(id);
        this.#apply(entry, read);
        for (const [id, value] of moved) {
          const item = entry.values.find((candidate) => candidate.id === id);
          const kept = item && clamped(item, value);
          if (kept === undefined || kept === item?.value) entry.draft.delete(id);
          else entry.draft.set(id, kept);
        }
      }
      this.#announce(project, entry);
      return result;
    });
  }

  setConnected(project: Project, connected: boolean): void {
    const entry = this.#entry(project);
    if (entry.connected === connected) return;
    entry.connected = connected;
    this.#announce(project, entry);
  }

  forget(project: Project): void {
    this.#entries.delete(project.id);
  }

  #entry(project: Project): Entry {
    let entry = this.#entries.get(project.id);
    if (!entry) {
      entry = { loaded: false, values: [], draft: new Map(), connected: false, queue: Promise.resolve(), sequence: this.#sequence };
      this.#entries.set(project.id, entry);
    }
    return entry;
  }

  /** One read or save at a time, so an older read never undoes a newer one. */
  #queued<R>(project: Project, work: (entry: Entry) => Promise<R>): Promise<R> {
    const entry = this.#entry(project);
    const run = entry.queue.then(() => work(entry));
    entry.queue = run.catch(() => undefined);
    return run;
  }

  #apply(entry: Entry, read: Read): void {
    entry.loaded = true;
    entry.file = read.file;
    entry.error = read.error;
    // A file caught half written or broken keeps the values and drafts it had.
    if (read.error) return;
    entry.values = read.values;
    for (const [id, value] of entry.draft) {
      const item = read.values.find((candidate) => candidate.id === id);
      const kept = item && clamped(item, value);
      if (kept === undefined || kept === item?.value) entry.draft.delete(id);
      else entry.draft.set(id, kept);
    }
  }

  #snapshot(entry: Entry): GameTuningState {
    return {
      sequence: entry.sequence,
      ...(entry.file ? { file: entry.file } : {}),
      values: entry.values,
      draft: Object.fromEntries(entry.draft),
      ...(entry.error ? { error: entry.error } : {}),
      connected: entry.connected,
    };
  }

  #announce(project: Project, entry: Entry): void {
    entry.sequence = ++this.#sequence;
    const state = this.#snapshot(entry);
    this.options.push(project, Object.fromEntries(entry.values.map((item) => [item.id, gameTuningValue(state, item)])));
    const published = JSON.stringify({ ...state, sequence: 0 });
    if (published === entry.published) return;
    entry.published = published;
    this.options.publish(project, state);
  }
}

export class GameTuningError extends Error {}

async function writeBeside(target: string, content: string): Promise<void> {
  // Hidden, so the preview doesn't take it for a change to the game.
  const temporary = path.join(path.dirname(target), `.tuning-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
