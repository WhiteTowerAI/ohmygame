import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

type Submission = { fingerprint: string; response?: unknown };
type Entry = { version: 1; fingerprint: string; task?: unknown; outputs?: unknown; submissions?: Record<string, Submission>; submissionScope?: string; unsafeStart?: true };
const validId = (id: string) => /^[a-zA-Z0-9-]{1,120}$/.test(id);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_SUBMISSIONS = 128;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function readEntry(value: unknown, inspection = false): Entry {
  if (!object(value) || !digest(value.fingerprint) || ("task" in value && "outputs" in value)) throw new Error("Invalid task record");
  // compat: since beta.5.8, remove from beta.7 and 2026-12-14. Legacy
  // unversioned single-task receipts retain their owner and ambiguous-start state.
  const legacy = !("version" in value);
  const keys = legacy ? ["fingerprint", "task", "outputs"] : ["version", "fingerprint", "task", "outputs", "submissions", "submissionScope", "unsafeStart"];
  if ((!legacy && value.version !== 1) || (!inspection && Object.keys(value).some(key => !keys.includes(key)))) throw new Error("Unsupported task record");
  if ("unsafeStart" in value && value.unsafeStart !== true) throw new Error("Invalid task record");
  if ("submissionScope" in value && (!digest(value.submissionScope) || !("submissions" in value))) throw new Error("Invalid submission scope");
  if ("submissions" in value) {
    if (!digest(value.submissionScope)) throw new Error("Invalid submission scope");
    if (!object(value.submissions) || Object.keys(value.submissions).length > MAX_SUBMISSIONS) throw new Error("Invalid submission records");
    for (const [id, receipt] of Object.entries(value.submissions)) {
      if (!validId(id) || !object(receipt) || !digest(receipt.fingerprint) || Object.keys(receipt).some(key => !["fingerprint", "response"].includes(key)) ||
        ("response" in receipt && Buffer.byteLength(JSON.stringify(receipt.response)) > MAX_RESPONSE_BYTES)) throw new Error("Invalid submission record");
    }
  }
  return { ...value, version: 1 } as Entry;
}

function parseEntry(text: string, inspection = false): Entry {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Invalid task record"); }
  return readEntry(value, inspection);
}

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
  /** Record and reuse one explicit paid step. An uncertain response must never be sent again. */
  submit<T>(id: string, scope: string, request: unknown, create: () => Promise<T>): Promise<T>;
  /** A raw start request cannot be safely replayed even if other steps have receipts. */
  unsafeStart(): Promise<void>;
  /** Whether partial paid work must survive even a terminal later-step error. */
  hasSubmissions(): boolean;
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

/** Structural inspection only: no claim, fingerprint match, vendor call or write.
 * A recorded task/result is opaque and does not prove it can be resumed.
 */
export async function inspectMediaTaskJournal(directory: string, id: string): Promise<"missing" | "unconfirmed" | "task-recorded" | "result-recorded"> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error("Invalid task recovery id");
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Linked task directory");
    const file = path.join(directory, `${id}.json`), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid task file");
    const value = parseEntry(await readFile(file, "utf8"), true);
    return "outputs" in value ? "result-recorded" : "task" in value ? "task-recorded" : "unconfirmed";
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw cause; }
}

export async function mediaTaskJournal(directory: string, id: string): Promise<MediaTaskJournal> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Error("Invalid task recovery id");
  const file = path.resolve(directory, `${id}.json`);
  let fingerprint: string | undefined;
  let entry: Entry | undefined;
  let held = false, closing = false, operations = 0;
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing || !held) return Promise.reject(new Error("Task ownership is required"));
    operations += 1;
    const work = pending.catch(() => {}).then(operation).finally(() => {
      operations -= 1;
      if (closing && held && operations === 0) { active.delete(file); held = false; }
    });
    pending = work;
    return work;
  };
  const load = async () => {
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("Linked task directory");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Invalid task file");
      return parseEntry(await readFile(file, "utf8"));
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
  };
  const write = async (next: Entry) => {
    readEntry(next);
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Linked task directory");
    // Refuse replacing an unreadable/future receipt, including a file changed
    // after begin. Only this profile owner writes valid records.
    const previous = await load();
    if (previous && previous.fingerprint !== next.fingerprint) throw new Error("Task ownership changed");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      entry = next;
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw cause;
    }
  };
  const owned = () => {
    if (!held || !entry || entry.fingerprint !== fingerprint) throw new Error("Task ownership is required");
    return entry;
  };
  return {
    async begin(request) {
      if (active.has(file)) throw new MediaTaskBusyError("This generation is still stopping. Try again in a moment.");
      active.add(file);
      held = true; closing = false;
      fingerprint = hash(request);
      entry = await load();
      if (entry) {
        if (entry.fingerprint !== fingerprint) return { state: "changed" };
        await write(entry);
        if ("outputs" in entry) return { state: "done", outputs: entry.outputs };
        if ("task" in entry) return { state: "resume", task: entry.task };
        // A staged start can run again using its durable responses. Any raw
        // write or legacy start retains the original conservative refusal.
        return entry.submissions && Object.keys(entry.submissions).length && !entry.unsafeStart ? { state: "new" } : { state: "unconfirmed" };
      }
      await write({ version: 1, fingerprint });
      return { state: "new" };
    },
    submit<T>(id: string, scope: string, request: unknown, create: () => Promise<T>): Promise<T> {
      return enqueue(async () => {
        const current = owned();
        if (!validId(id)) throw new Error("Invalid submission id");
        const submissionScope = hash(scope);
        if (current.submissionScope && current.submissionScope !== submissionScope) throw new Error("The media adapter changed after this generation started. Restore the original plugin version to resume, or start a new generation.");
        const fingerprint = hash(request), previous = current.submissions && Object.hasOwn(current.submissions, id) ? current.submissions[id] : undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error("This paid step changed. Restore its original request or start a new generation.");
          if (!("response" in previous)) throw new Error("This paid step may already have been submitted, but its response was lost. Check the provider before starting a new generation; retry will not submit it again.");
          return structuredClone(previous.response) as T;
        }
        if (Object.keys(current.submissions ?? {}).length >= MAX_SUBMISSIONS) throw new Error("Too many paid steps in this generation");
        await write({ ...current, submissionScope, submissions: { ...current.submissions, [id]: { fingerprint } } });
        const response = await create();
        const text = JSON.stringify(response);
        if (text === undefined || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Paid step response cannot be recorded; check the provider before starting a new generation");
        const saved = JSON.parse(text) as T;
        await write({ ...owned(), submissions: { ...owned().submissions, [id]: { fingerprint, response: saved } } });
        return structuredClone(saved);
      });
    },
    unsafeStart() { return enqueue(async () => { await write({ ...owned(), unsafeStart: true }); }); },
    hasSubmissions() { return !!entry?.submissions && Object.keys(entry.submissions).length > 0; },
    save(task) { return enqueue(async () => { const { outputs: _, ...current } = owned(); await write({ ...current, task }); }); },
    finish(outputs) { return enqueue(async () => { const { task: _, ...current } = owned(); await write({ ...current, outputs }); }); },
    async clear() {
      if (active.has(file) && !held) throw new MediaTaskBusyError("This generation is still stopping. Try again in a moment.");
      // A caller clears after storing the result, often after releasing its lease.
      const remove = async () => { await load(); await rm(file, { force: true }); entry = undefined; };
      if (held && !closing) await enqueue(remove);
      else {
        if (operations) throw new MediaTaskBusyError("This generation is still stopping. Try again in a moment.");
        active.add(file);
        try { await remove(); } finally { active.delete(file); }
      }
    },
    release() {
      closing = true;
      // Pending submissions own their writes even when the VM/waiter has exited.
      // Keep the lease until they settle; a retry cannot race a late receipt.
      if (held && operations === 0) { active.delete(file); held = false; }
    },
  };
}
