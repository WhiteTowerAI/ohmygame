import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** The ages, in days, after which the file history can be cleared automatically; 0 keeps it. */
export const FILE_HISTORY_AUTO_CLEAR_DAYS = [0, 7, 30, 90, 365] as const;

/**
 * After how many days every project's file history is cleared automatically,
 * with its prune. Zero, the default, keeps it until the user clears it.
 */
export class FileHistorySettingsStore {
  #days = 0;
  #problem?: string;
  #loaded?: Promise<void>;
  #queue = Promise.resolve();
  readonly #file: string;

  constructor(directory: string) {
    this.#file = path.join(directory, "file-history-settings.json");
  }

  async get(): Promise<{ autoClearDays: number; problem?: string }> {
    await (this.#loaded ??= this.#load());
    return {
      autoClearDays: this.#days,
      ...(this.#problem ? { problem: this.#problem } : {}),
    };
  }

  set(autoClearDays: number): Promise<{ autoClearDays: number }> {
    const run = this.#queue.then(async () => {
      await this.get();
      if (this.#problem) throw new Error(this.#problem);
      if (!allowed(autoClearDays)) throw new Error("Invalid file history age");
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, autoClearDays }) + "\n",
          { mode: 0o600 },
        );
        await rename(temporary, this.#file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.#days = autoClearDays;
      return { autoClearDays };
    });
    this.#queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.#file, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        stored.version !== 1 ||
        !allowed(stored.autoClearDays) ||
        Object.keys(stored).some(
          (key) => !["version", "autoClearDays"].includes(key),
        )
      )
        throw new Error("Unsupported settings");
      this.#days = stored.autoClearDays;
    } catch (cause) {
      // Settings that cannot be read clear nothing, and are left as they are.
      this.#days = 0;
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
        this.#problem =
          "File history settings cannot be read. Fix or remove file-history-settings.json before changing them.";
    }
  }
}

function allowed(days: unknown): days is number {
  return (FILE_HISTORY_AUTO_CLEAR_DAYS as readonly unknown[]).includes(days);
}
