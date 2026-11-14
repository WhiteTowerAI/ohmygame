import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Model3DGenerationError, type Model3DExecution } from "./model3d.js";

type Entry = { fingerprint: string; credentials?: Record<string, string> };
type Journal = { version: 1; entries: Record<string, Entry> };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validId = (id: string) => /^[a-zA-Z0-9-]{1,120}$/.test(id);
function readJournal(text: string): { journal: Journal; legacy: boolean } {
  // Parser errors can contain private task credentials. Expose only a fixed message.
  const invalid = () => new Model3DGenerationError("The 3D task record is unreadable or unsupported. It was left unchanged; no new task was submitted.", 409);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (!object(value)) throw invalid();
  // compat: since beta.5.8, remove from beta.7 and 2026-12-15. Keep unversioned
  // native 3D stage receipts and ambiguous submissions when loading old jobs.
  const legacy = !Object.hasOwn(value, "version");
  if (!legacy && (value.version !== 1 || Object.keys(value).some(key => !["version", "entries"].includes(key)))) throw invalid();
  const entries = legacy ? value : value.entries;
  if (!object(entries)) throw invalid();
  for (const [stage, entry] of Object.entries(entries)) {
    if (!validId(stage) || !object(entry) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)
      || Object.keys(entry).some(key => !["fingerprint", "credentials"].includes(key))) throw invalid();
    if (Object.hasOwn(entry, "credentials") && (!object(entry.credentials) || !Object.keys(entry.credentials).length
      || Object.values(entry.credentials).some(value => typeof value !== "string" || !value))) throw invalid();
  }
  return { journal: { version: 1, entries: entries as Record<string, Entry> }, legacy };
}
// Original and copied jobs may share a recovery ID. Serialize only submission,
// not polling or downloads, across journal instances in the daemon.
const submissions = new Map<string, Promise<unknown>>();
/** Persist before and immediately after every paid submission. A lost POST response cannot safely be resubmitted. */
export async function model3DJournal(directory: string, id: string): Promise<Model3DExecution> {
  if (!validId(id)) throw new Model3DGenerationError("Invalid task recovery ID", 400);
  await mkdir(directory, { recursive: true });
  const file = path.resolve(directory, `${id}.json`);
  return {
    async submitted<T extends Record<string, string>>(stage: string, scope: string, input: unknown, create: () => Promise<T>): Promise<T> {
      if (!validId(stage)) throw new Model3DGenerationError("Invalid task stage ID", 400);
      const pending = (submissions.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        // Read under the lock: a different instance may have completed this stage.
        let loaded: ReturnType<typeof readJournal> = { journal: { version: 1, entries: {} }, legacy: false };
        try { loaded = readJournal(await readFile(file, "utf8")); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
        const { journal, legacy } = loaded, { entries } = journal;
        const save = async () => {
          try {
            await writeFile(`${file}.tmp`, JSON.stringify(journal), { mode: 0o600 });
            await rename(`${file}.tmp`, file);
          } catch (cause) {
            await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
            throw cause;
          }
        };
        // Upgrade only after the complete record is understood, under the same submission lock.
        if (legacy) await save();
        const fingerprint = createHash("sha256").update(scope).update(JSON.stringify(input)).digest("hex");
        const previous = Object.hasOwn(entries, stage) ? entries[stage] : undefined;
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Model3DGenerationError("Provider connection or input changed. Restore the original settings to resume, or start a new generation.", 409);
          if (!previous.credentials) throw new Model3DGenerationError("Submission could not be confirmed. Check the provider dashboard before starting a new generation; retry will not submit another paid task.", 409);
          return previous.credentials as T;
        }
        entries[stage] = { fingerprint };
        await save();
        let credentials: T;
        try { credentials = await create(); }
        catch (cause) {
          // A definite validation/rate-limit rejection created no task. Network errors and invalid success responses remain ambiguous.
          if (cause instanceof Model3DGenerationError && [400, 429].includes(cause.statusCode)) { delete entries[stage]; await save(); }
          throw cause;
        }
        if (!object(credentials) || !Object.keys(credentials).length || Object.values(credentials).some(value => typeof value !== "string" || !value)) {
          // The request may have been accepted: leave the pre-submission marker in place.
          throw new Model3DGenerationError("The provider returned invalid task credentials. Retry will not submit another paid task.", 502);
        }
        entries[stage] = { fingerprint, credentials };
        await save();
        return credentials;
      });
      submissions.set(file, pending);
      try { return await pending; }
      finally { if (submissions.get(file) === pending) submissions.delete(file); }
    },
  };
}
