import { createHash } from "node:crypto";
import {
  GenerationShutdown,
  mediaTaskJournal,
  type MediaTaskJournal,
} from "./media-task-journal.js";

/** A daemon-owned paid prerequisite, shared by otherwise independent jobs.
 * Scope is supplied by the host (package, account, inputs), never a plugin path.
 * Only a successful, explicit validity check may replace a saved prerequisite.
 */
export class MediaTaskReuse {
  readonly #pending = new Map<string, Promise<unknown>>();
  readonly #shutdown = new AbortController();

  constructor(private readonly directory: string) {}

  async use(
    scope: unknown,
    validate: (value: unknown, signal: AbortSignal) => Promise<boolean>,
    create: (
      journal: MediaTaskJournal,
      signal: AbortSignal,
    ) => Promise<unknown>,
    waiter?: AbortSignal,
  ): Promise<unknown> {
    waiter?.throwIfAborted();
    this.#shutdown.signal.throwIfAborted();
    // Object field order is not a different rig setting. Keep array order,
    // which can carry meaning, while normalizing host-owned JSON objects.
    const text = JSON.stringify(scope, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          )
        : value,
    );
    const normalized: unknown = JSON.parse(text);
    const id = createHash("sha256").update(text).digest("hex");
    let work = this.#pending.get(id);
    if (!work) {
      work = this.#run(id, normalized, validate, create).finally(() =>
        this.#pending.delete(id),
      );
      this.#pending.set(id, work);
    }
    // The waiter never owns the shared request or its journal lease.
    const value = await new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(waiter!.reason);
      waiter?.addEventListener("abort", abort, { once: true });
      void work
        .then(resolve, reject)
        .finally(() => waiter?.removeEventListener("abort", abort));
    });
    return structuredClone(value);
  }

  async #run(
    id: string,
    scope: unknown,
    validate: (value: unknown, signal: AbortSignal) => Promise<boolean>,
    create: (
      journal: MediaTaskJournal,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ): Promise<unknown> {
    const signal = this.#shutdown.signal;
    const journal = await mediaTaskJournal(this.directory, id);
    let creating = false;
    try {
      const previous = await journal.begin(scope);
      if (previous.state === "done") {
        const valid = await validate(structuredClone(previous.outputs), signal);
        signal.throwIfAborted();
        if (valid === true) return previous.outputs;
        if (valid !== false)
          throw new Error(
            "Shared task validation must confirm valid or expired",
          );
        // Keep the lease until the old receipt is removed. No concurrent waiter
        // can replace a newer entry with its stale expiry observation.
        await journal.clear();
        journal.release();
        return await this.#run(id, scope, validate, create);
      }
      if (previous.state !== "new")
        throw new Error(
          "The shared paid task cannot safely be recreated; check the provider before retrying",
        );
      creating = true;
      const value = await create(journal, signal);
      const text = JSON.stringify(value);
      if (text === undefined || Buffer.byteLength(text) > 16 * 1024)
        throw new Error("Shared task value must fit in 16 KB of JSON");
      const saved: unknown = JSON.parse(text);
      await journal.finish(saved);
      return saved;
    } catch (cause) {
      // A rejected callback before any paid submission can be tried again.
      // Uncertain or completed submissions must remain, including at shutdown.
      if (creating && !journal.hasSubmissions()) await journal.clear();
      throw cause;
    } finally {
      await journal.settled();
      journal.release();
    }
  }

  async close(): Promise<void> {
    this.#shutdown.abort(new GenerationShutdown());
    await Promise.allSettled([...this.#pending.values()]);
  }
}
