// The caller owns the directory and excludes all live settings stores. Startup
// recovery runs under the daemon profile owner, before creating the application.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import {
  equal,
  snapshot as readSnapshot,
  same as sameSnapshot,
  type Snapshot as MediaSnapshot,
} from "./media-settings-snapshot.js";

const pending = new Map<string, Promise<unknown>>();

/** Serializes callers in this process. A fresh process may recover only after its predecessor exits. */
async function owned<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = realpathSync(directory);
  const next = (pending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(operation);
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}

/** A vendor-specific receipt and immutable legacy source share the same transaction engine. */
export function createSettingsTransaction<File extends string>(options: {
  files: readonly File[];
  source: File;
  journal: string;
  backup: string;
  label: string;
}) {
  const {
    files: FILES,
    source,
    journal: SETTINGS_TRANSACTION_FILE,
    backup: SETTINGS_TRANSACTION_BACKUP,
    label,
  } = options;
  type Snapshot = MediaSnapshot<File>;
  type Phase = "applying" | "applied" | "rolling-back" | "rolled-back";
  type StoredFile = { before: string | null; after: string | null };
  interface Journal {
    version: 1;
    phase: Phase;
    files: Record<File, StoredFile>;
    checksum: string;
  }
  const snapshot = (directory: string) => readSnapshot(directory, FILES);
  const same = (a: Snapshot, b: Snapshot) => sameSnapshot(a, b, FILES);

  /** Persist the complete intent before changing either settings file. Never replace an existing journal. */
  function prepareSettingsTransaction(
    directory: string,
    before: Snapshot,
    changes: Snapshot,
  ): Promise<void> {
    return owned(directory, async () => {
      if (
        (await exists(path.join(directory, SETTINGS_TRANSACTION_FILE))) ||
        (await exists(path.join(directory, SETTINGS_TRANSACTION_BACKUP)))
      )
        throw new Error("Migration journal or committed backup already exists");
      if (
        before.size !== FILES.length ||
        FILES.some((file) => !before.has(file)) ||
        [...changes.keys()].some(
          (file) => !FILES.includes(file) || file === source,
        ) ||
        [...changes.values()].some((bytes) => bytes === undefined)
      )
        throw new Error("Invalid settings migration plan");
      if (!same(await snapshot(directory), before))
        throw new Error("Settings changed before migration");
      const files = Object.fromEntries(
        FILES.map((file) => [
          file,
          {
            before: encode(before.get(file)),
            after: encode(
              changes.has(file) ? changes.get(file) : before.get(file),
            ),
          },
        ]),
      ) as Journal["files"];
      await save(directory, {
        version: 1,
        phase: "applying",
        files,
        checksum: "",
      });
    });
  }

  /** A saved rollback intent is sticky: recovery must never start applying again. */
  function resumeSettingsTransaction(directory: string): Promise<Phase> {
    return owned(directory, async () => {
      const journal = await load(directory);
      return advance(
        directory,
        journal,
        journal.phase === "rolling-back" || journal.phase === "rolled-back",
      );
    });
  }

  function rollbackSettingsTransaction(directory: string): Promise<Phase> {
    return owned(directory, async () =>
      rollback(directory, await load(directory)),
    );
  }

  async function rollback(directory: string, journal: Journal): Promise<Phase> {
    // Check every file before saving an intent or making the first rollback write.
    await check(directory, journal);
    if (journal.phase !== "rolling-back" && journal.phase !== "rolled-back") {
      journal.phase = "rolling-back";
      await save(directory, journal);
    }
    return advance(directory, journal, true);
  }

  /**
   * Startup rolls back uncommitted settings before any store or plugin reads them.
   * A later activation can retry its full preflight against the restored snapshot.
   */
  function recoverInterruptedSettings(directory: string): Promise<boolean> {
    // A profile may be reached through a directory alias; child links remain refused.
    directory = realpathSync(directory);
    return owned(directory, async () => {
      if (!(await exists(path.join(directory, SETTINGS_TRANSACTION_FILE))))
        return false;
      if (await exists(path.join(directory, SETTINGS_TRANSACTION_BACKUP)))
        throw new Error(
          `Both active and committed ${label} migration records exist`,
        );
      await rollback(directory, await load(directory));
      await rm(path.join(directory, SETTINGS_TRANSACTION_FILE));
      return true;
    });
  }

  /**
   * The activation owner calls this only after reloading/validating all target
   * stores. Atomic rename seals the migration and retains the original bytes.
   */
  function commitSettingsTransaction(directory: string): Promise<void> {
    return owned(directory, async () => {
      const journal = await load(directory);
      if (
        journal.phase !== "applied" ||
        !same(await snapshot(directory), side(journal, "after"))
      )
        throw new Error("Migration is not completely applied");
      if (await exists(path.join(directory, SETTINGS_TRANSACTION_BACKUP)))
        throw new Error("Committed migration backup already exists");
      await rename(
        path.join(directory, SETTINGS_TRANSACTION_FILE),
        path.join(directory, SETTINGS_TRANSACTION_BACKUP),
      );
    });
  }

  /** Committed settings are mutable; validate the receipt, not equality to old values. */
  function hasCommittedSettingsTransaction(
    directory: string,
  ): Promise<boolean> {
    return owned(directory, async () => {
      if (!(await exists(path.join(directory, SETTINGS_TRANSACTION_BACKUP))))
        return false;
      const journal = await load(directory, SETTINGS_TRANSACTION_BACKUP);
      if (journal.phase !== "applied")
        throw new Error("Invalid committed migration phase");
      return true;
    });
  }

  /** The copy owner can discard the backup only after byte-exact restoration. */
  function forgetSettingsTransaction(directory: string): Promise<void> {
    return owned(directory, async () => {
      const journal = await load(directory);
      if (
        journal.phase !== "rolled-back" ||
        !same(await snapshot(directory), side(journal, "before"))
      )
        throw new Error("Migration rollback is not complete");
      await rm(path.join(directory, SETTINGS_TRANSACTION_FILE));
    });
  }

  async function advance(
    directory: string,
    journal: Journal,
    rollback: boolean,
  ): Promise<Phase> {
    const target = side(journal, rollback ? "before" : "after");
    const terminal = rollback ? "rolled-back" : "applied";
    const current = await check(directory, journal);
    if (journal.phase === "applied" || journal.phase === "rolled-back") {
      if (!same(current, target))
        throw new Error("Completed migration settings changed");
      return journal.phase;
    }
    for (const file of FILES) {
      // Catch intervening edits before each write. The owner still must exclude other writers.
      const now = await check(directory, journal);
      const bytes = target.get(file);
      if (equal(now.get(file), bytes)) continue;
      if (bytes === undefined) await rm(path.join(directory, file));
      else await atomic(directory, file, bytes);
    }
    if (!same(await snapshot(directory), target))
      throw new Error("Settings changed during migration");
    journal.phase = terminal;
    await save(directory, journal);
    return terminal;
  }

  async function check(directory: string, journal: Journal): Promise<Snapshot> {
    const current = await snapshot(directory);
    const before = side(journal, "before"),
      after = side(journal, "after");
    for (const file of FILES)
      if (
        !equal(current.get(file), before.get(file)) &&
        !equal(current.get(file), after.get(file))
      )
        throw new Error("Settings conflict with migration journal");
    return current;
  }

  function encode(value: Buffer | undefined): string | null {
    return value === undefined ? null : value.toString("base64");
  }
  function side(journal: Journal, which: "before" | "after"): Snapshot {
    return new Map(
      FILES.map((file) => [
        file,
        journal.files[file][which] === null
          ? undefined
          : Buffer.from(journal.files[file][which]!, "base64"),
      ]),
    );
  }
  function checksum(journal: Omit<Journal, "checksum">): string {
    return createHash("sha256").update(JSON.stringify(journal)).digest("hex");
  }
  async function exists(file: string): Promise<boolean> {
    try {
      await lstat(file);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
  }
  function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function fields(
    value: Record<string, unknown>,
    names: readonly string[],
  ): boolean {
    return (
      Object.keys(value).length === names.length &&
      names.every((name) => Object.hasOwn(value, name))
    );
  }
  async function load(
    directory: string,
    name = SETTINGS_TRANSACTION_FILE,
  ): Promise<Journal> {
    // Validate the owned copy and reject linked stores/journals before reading a recovery plan.
    await snapshot(directory);
    const file = path.join(directory, name),
      info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Invalid migration journal file");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch {
      throw new Error("Unreadable migration journal");
    }
    if (
      !record(value) ||
      !fields(value, ["version", "phase", "files", "checksum"]) ||
      value.version !== 1 ||
      !["applying", "applied", "rolling-back", "rolled-back"].includes(
        String(value.phase),
      ) ||
      !record(value.files) ||
      !fields(value.files, FILES)
    )
      throw new Error("Unsupported migration journal");
    for (const file of FILES) {
      const entry = value.files[file];
      if (!record(entry) || !fields(entry, ["before", "after"]))
        throw new Error("Invalid migration journal entries");
      for (const bytes of Object.values(entry))
        if (
          bytes !== null &&
          (typeof bytes !== "string" ||
            Buffer.from(bytes, "base64").toString("base64") !== bytes)
        )
          throw new Error("Invalid migration journal bytes");
      if (
        entry.before !== entry.after &&
        (file === source || entry.after === null)
      )
        throw new Error("Invalid migration journal transition");
    }
    const { checksum: saved, ...payload } = value;
    if (saved !== checksum(payload as Omit<Journal, "checksum">))
      throw new Error("Migration journal checksum mismatch");
    return value as unknown as Journal;
  }
  async function save(directory: string, journal: Journal): Promise<void> {
    const { checksum: _, ...payload } = journal;
    await atomic(
      directory,
      SETTINGS_TRANSACTION_FILE,
      Buffer.from(
        JSON.stringify({ ...payload, checksum: checksum(payload) }) + "\n",
      ),
    );
  }
  async function atomic(
    directory: string,
    file: string,
    bytes: Buffer,
  ): Promise<void> {
    const target = path.join(directory, file),
      temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  return {
    prepareSettingsTransaction,
    resumeSettingsTransaction,
    rollbackSettingsTransaction,
    recoverInterruptedSettings,
    commitSettingsTransaction,
    hasCommittedSettingsTransaction,
    forgetSettingsTransaction,
  };
}
