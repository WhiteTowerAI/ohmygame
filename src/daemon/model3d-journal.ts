import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Model3DGenerationError, type Model3DExecution } from "./model3d.js";

type Entry = { fingerprint: string; credentials?: Record<string, string> };
// Original and copied jobs may share a recovery ID. Serialize only submission,
// not polling or downloads, across journal instances in the daemon.
const submissions = new Map<string, Promise<unknown>>();
/** Persist before and immediately after every paid submission. A lost POST response cannot safely be resubmitted. */
export async function model3DJournal(directory: string, id: string): Promise<Model3DExecution> {
  if (!/^[a-zA-Z0-9-]{1,120}$/.test(id)) throw new Model3DGenerationError("Invalid task recovery ID", 400);
  await mkdir(directory, { recursive: true });
  const file = path.resolve(directory, `${id}.json`);
  return {
    async submitted<T extends Record<string, string>>(stage: string, scope: string, input: unknown, create: () => Promise<T>): Promise<T> {
      const pending = (submissions.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
        // Read under the lock: a different instance may have completed this stage.
        let entries: Record<string, Entry> = {};
        try { entries = JSON.parse(await readFile(file, "utf8")); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
        const save = async () => {
          try {
            await writeFile(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
            await rename(`${file}.tmp`, file);
          } catch (cause) {
            await rm(`${file}.tmp`, { force: true }).catch(() => undefined);
            throw cause;
          }
        };
        const fingerprint = createHash("sha256").update(scope).update(JSON.stringify(input)).digest("hex");
        const previous = entries[stage];
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
