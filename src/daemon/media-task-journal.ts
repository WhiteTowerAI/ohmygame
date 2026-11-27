import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { replaceFile } from "./replace-file.js";

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
    super("OhMyGame is shutting down.");
    this.name = "GenerationShutdown";
  }
}

type Submission = { fingerprint: string; response?: unknown };
type Entry = { version: 1; fingerprint: string; task?: unknown; outputs?: unknown; submissions?: Record<string, Submission>; submissionScope?: string; unsafeStart?: true };
const validId = (id: string) => /^[a-zA-Z0-9-]{1,120}$/.test(id);
const validReceiptId = (id: string) => validId(id) || /^_reuse-[a-zA-Z0-9-]{1,100}$/.test(id);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_SUBMISSIONS = 128;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Binary responses stay outside JSON receipts and the adapter VM. */
export const MEDIA_TASK_FILE_MAX_BYTES = 64 * 1024 * 1024;
type SaveTaskFile = (bytes: Uint8Array) => Promise<string>;

function readEntry(value: unknown, inspection = false): Entry {
  if (!object(value) || !digest(value.fingerprint) || ("task" in value && "outputs" in value)) throw new Error("Invalid task record");
  // compat: since beta.5.8, remove from beta.7 and 2026-12-18. Legacy
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
      if (!validReceiptId(id) || !object(receipt) || !digest(receipt.fingerprint) || Object.keys(receipt).some(key => !["fingerprint", "response"].includes(key)) ||
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
  submit<T>(id: string, scope: string, request: unknown, create: (saveFile: SaveTaskFile) => Promise<T>): Promise<T>;
  /** Read only a file saved under this generation's request identity. */
  readOutput(file: string): Promise<Buffer>;
  /** Pin a reference whose paid work has its own durable owner; failed resolution is retryable. */
  reference<T>(id: string, scope: string, request: unknown, resolve: () => Promise<T>): Promise<T>;
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
  /** Wait for owned receipt writes, including work whose VM has stopped. */
  settled(): Promise<void>;
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
  const files = path.resolve(directory, `${id}.files`);
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
      await replaceFile(temporary, file);
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
  const checkFiles = async (create = false) => {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Linked task directory");
    if (create) await mkdir(files, { recursive: true, mode: 0o700 });
    const info = await lstat(files);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid task files directory");
  };
  const readOutputBytes = async (target: string) => {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || !info.size || info.size > MEDIA_TASK_FILE_MAX_BYTES)
      throw new Error("Invalid task output file");
    const handle = await open(target, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink > 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
        throw new Error("Task output changed");
      // Read at most the checked size plus one, even if a file grows during the read.
      const bytes = Buffer.alloc(info.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const part = await handle.read(bytes, size, bytes.length - size, size);
        if (!part.bytesRead) break;
        size += part.bytesRead;
      }
      if (size !== info.size) throw new Error("Task output changed");
      return bytes.subarray(0, size);
    } finally { await handle.close(); }
  };
  const saveFile: SaveTaskFile = async (value) => {
    const owner = owned().fingerprint;
    if (!value.byteLength || value.byteLength > MEDIA_TASK_FILE_MAX_BYTES) throw new Error("Task output must be between 1 byte and 64 MB");
    const bytes = Buffer.from(value);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const token = `${owner}-${digest}`;
    await checkFiles(true);
    let size = 0;
    for (const name of await readdir(files)) {
      const info = await lstat(path.join(files, name));
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(name) || !info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > MEDIA_TASK_FILE_MAX_BYTES)
        throw new Error("Invalid task output file");
      size += info.size;
    }
    const target = path.join(files, token);
    try {
      const old = await readOutputBytes(target);
      if (!old.equals(bytes)) throw new Error("Task output changed");
      return token;
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    if (size + bytes.length > MEDIA_TASK_FILE_MAX_BYTES) throw new Error("Task outputs exceed 64 MB");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await replaceFile(temporary, target);
    } catch (cause) { await rm(temporary, { force: true }).catch(() => undefined); throw cause; }
    return token;
  };
  const record = <T>(id: string, scope: string, request: unknown, create: (saveFile: SaveTaskFile) => Promise<T>, intent: boolean): Promise<T> => {
    return enqueue(async () => {
      const current = owned();
      if (!(intent ? validId(id) : validReceiptId(id))) throw new Error("Invalid submission id");
      const submissionScope = hash(scope);
      if (current.submissionScope && current.submissionScope !== submissionScope) throw new Error("The media adapter changed after this generation started. Restore the original plugin version to resume, or start a new generation.");
      const fingerprint = hash(request), previous = current.submissions && Object.hasOwn(current.submissions, id) ? current.submissions[id] : undefined;
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("This paid step changed. Restore its original request or start a new generation.");
        if (!("response" in previous)) throw new Error("This paid step may already have been submitted, but its response was lost. Check the provider before starting a new generation; retry will not submit it again.");
        return structuredClone(previous.response) as T;
      }
      if (Object.keys(current.submissions ?? {}).length >= MAX_SUBMISSIONS) throw new Error("Too many paid steps in this generation");
      if (intent) await write({ ...current, submissionScope, submissions: { ...current.submissions, [id]: { fingerprint } } });
      let accepting = true;
      const response = await create(bytes => {
        if (!intent || !accepting) throw new Error("Only an active paid step can save a task output");
        return saveFile(bytes);
      }).finally(() => { accepting = false; });
      const text = JSON.stringify(response);
      if (text === undefined || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Paid step response cannot be recorded; check the provider before starting a new generation");
      const saved = JSON.parse(text) as T;
      await write({ ...owned(), submissionScope, submissions: { ...owned().submissions, [id]: { fingerprint, response: saved } } });
      return structuredClone(saved);
    });
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
    submit: (id, scope, request, create) => record(id, scope, request, create, true),
    async readOutput(token) {
      const owner = owned().fingerprint;
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(token) || !token.startsWith(`${owner}-`)) throw new Error("Invalid task output reference");
      await checkFiles();
      const bytes = await readOutputBytes(path.join(files, token));
      if (createHash("sha256").update(bytes).digest("hex") !== token.slice(65)) throw new Error("Task output changed");
      return bytes;
    },
    reference: (id, scope, request, resolve) => record(id, scope, request, resolve, false),
    unsafeStart() { return enqueue(async () => { await write({ ...owned(), unsafeStart: true }); }); },
    hasSubmissions() { return !!entry?.submissions && Object.keys(entry.submissions).length > 0; },
    save(task) { return enqueue(async () => { const { outputs: _, ...current } = owned(); await write({ ...current, task }); }); },
    finish(outputs) { return enqueue(async () => { const { task: _, ...current } = owned(); await write({ ...current, outputs }); }); },
    async clear() {
      if (active.has(file) && !held) throw new MediaTaskBusyError("This generation is still stopping. Try again in a moment.");
      // A caller clears after storing the result, often after releasing its lease.
      const remove = async () => {
        await load();
        let names: string[] = [];
        try { await checkFiles(); names = await readdir(files); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
        // Do not erase a future layout or unrelated data in this task's directory.
        for (const name of names) {
          const info = await lstat(path.join(files, name));
          if (!/^[a-f0-9]{64}-[a-f0-9]{64}(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name) || !(info.isFile() || info.isSymbolicLink()))
            throw new Error("Unsupported task output layout");
        }
        await rm(file, { force: true });
        await rm(files, { recursive: true, force: true });
        entry = undefined;
      };
      if (held && !closing) await enqueue(remove);
      else {
        if (operations) throw new MediaTaskBusyError("This generation is still stopping. Try again in a moment.");
        active.add(file);
        try { await remove(); } finally { active.delete(file); }
      }
    },
    async settled() { await pending.catch(() => {}); },
    release() {
      closing = true;
      // Pending submissions own their writes even when the VM/waiter has exited.
      // Keep the lease until they settle; a retry cannot race a late receipt.
      if (held && operations === 0) { active.delete(file); held = false; }
    },
  };
}
