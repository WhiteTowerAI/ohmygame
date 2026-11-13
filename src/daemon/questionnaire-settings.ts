import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Seconds before accepting explicit recommendations; zero means manual answers. */
export class QuestionnaireSettingsStore {
  #seconds = 0;
  #problem?: string;
  #loaded?: Promise<void>;
  #queue = Promise.resolve();
  readonly #file: string;

  constructor(directory: string) {
    this.#file = path.join(directory, "questionnaire-settings.json");
  }

  get seconds(): number {
    return this.#seconds;
  }

  async get(): Promise<{ delaySeconds: number; problem?: string }> {
    await (this.#loaded ??= this.#load());
    return {
      delaySeconds: this.#seconds,
      ...(this.#problem ? { problem: this.#problem } : {}),
    };
  }

  set(delaySeconds: number): Promise<{ delaySeconds: number }> {
    const run = this.#queue.then(async () => {
      await this.get();
      if (this.#problem) throw new Error(this.#problem);
      if (![0, 60, 180, 300].includes(delaySeconds))
        throw new Error("Invalid question timeout");
      await mkdir(path.dirname(this.#file), { recursive: true });
      const temporary = `${this.#file}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, delaySeconds }) + "\n",
          { mode: 0o600 },
        );
        await rename(temporary, this.#file);
      } finally {
        await rm(temporary, { force: true });
      }
      this.#seconds = delaySeconds;
      return { delaySeconds };
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
        ![0, 60, 180, 300].includes(stored.delaySeconds as number) ||
        Object.keys(stored).some(
          (key) => !["version", "delaySeconds"].includes(key),
        )
      )
        throw new Error("Unsupported settings");
      this.#seconds = stored.delaySeconds as number;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        this.#seconds = 60;
      } else {
        this.#problem =
          "Question settings cannot be read. Fix or remove questionnaire-settings.json before changing them.";
      }
    }
  }
}
