import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Keeps the task a plugin's media adapter left with its vendor, under the
// generation's recovery id, so retrying a generation the daemon's restart cut
// off checks that task again instead of paying for a new one. It is written
// before `start` and after every answer that changes the task (or, for a
// vendor that answered at once, its result), kept until the video is stored,
// and removed once the generation ends for good. Like 3D (`model3d-journal.ts`), a start
// whose answer was lost isn't repeated.

/** Why the daemon stopped a generation: it is shutting down, and the task stays to resume. */
export class GenerationShutdown extends Error {
  constructor() {
    super("OhMyGame is shutting down. Retry to resume.");
    this.name = "GenerationShutdown";
  }
}

type Entry = { fingerprint: string; task?: unknown; outputs?: unknown };

/** How an earlier run of the same request left it. */
export type MediaTaskStart =
  | { state: "new" }
  | { state: "resume"; task: unknown }
  /** The vendor finished: only fetching and storing its result is left. */
  | { state: "done"; outputs: unknown }
  /** The request or provider differs from the one that started the task. */
  | { state: "changed" }
  /** A start was sent, but whether the vendor took it is unknown. */
  | { state: "unconfirmed" };

export interface MediaTaskJournal {
  /** Reads what an earlier run left, and marks a new start when it left nothing. */
  begin(request: unknown): Promise<MediaTaskStart>;
  /** The task the vendor now holds. */
  save(task: unknown): Promise<void>;
  /** The result of a vendor that answered without a task, kept until stored, so a retry fetches it again rather than paying anew. */
  finish(outputs: unknown): Promise<void>;
  /** The generation ended for good: there's nothing to resume. */
  clear(): Promise<void>;
  /** Lets another run of the same request begin. */
  release(): void;
}

/** Requests being run now; a second run of one at the same time is refused. */
const active = new Set<string>();

export class MediaTaskBusyError extends Error {}

export async function mediaTaskJournal(directory: string, id: string): Promise<MediaTaskJournal> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error("Invalid task recovery id");
  const file = path.resolve(directory, `${id}.json`);
  let fingerprint: string | undefined;
  let held = false;
  const write = async (entry: Entry) => {
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch (cause) {
      await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
      throw cause;
    }
  };
  return {
    async begin(request) {
      if (active.has(file)) throw new MediaTaskBusyError("This generation is still stopping. Try again in a moment.");
      active.add(file);
      held = true;
      fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      let entry: Entry | undefined;
      try {
        entry = JSON.parse(await readFile(file, "utf8")) as Entry;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      if (entry) {
        if (entry.fingerprint !== fingerprint) return { state: "changed" };
        if ("outputs" in entry) return { state: "done", outputs: entry.outputs };
        return "task" in entry ? { state: "resume", task: entry.task } : { state: "unconfirmed" };
      }
      await write({ fingerprint });
      return { state: "new" };
    },
    async save(task) {
      if (fingerprint) await write({ fingerprint, task });
    },
    async finish(outputs) {
      if (fingerprint) await write({ fingerprint, outputs });
    },
    async clear() {
      await rm(file, { force: true });
    },
    release() {
      if (held) active.delete(file);
      held = false;
    },
  };
}
