import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { Snapshot } from "./media-settings-snapshot.js";

/** The caller owns the profile and has not constructed any live settings consumers. */
export async function migrateMediaSettings<
  File extends string,
  Report extends { blockers: string[]; regions: { key: string }[] },
>(
  directory: string,
  safeMode: boolean,
  options: {
    sourceFile: File;
    label: string;
    snapshot(directory: string): Promise<Snapshot<File>>;
    inspect(directory: string): Promise<Report>;
    propose(
      original: Snapshot<File>,
      inspected: Report,
    ): { changes: Snapshot<File> };
    packageIssue(directory: string): Promise<string | undefined>;
    transaction: {
      recover(directory: string): Promise<boolean>;
      committed(directory: string): Promise<boolean>;
      prepare(
        directory: string,
        before: Snapshot<File>,
        changes: Snapshot<File>,
      ): Promise<void>;
      resume(directory: string): Promise<string>;
      commit(directory: string): Promise<void>;
    };
  },
): Promise<{
  status: "unchanged" | "deferred" | "migrated" | "committed";
  reasons: string[];
}> {
  const {
    sourceFile,
    label,
    snapshot,
    inspect,
    propose,
    packageIssue,
    transaction,
  } = options;
  directory = await realpath(directory);
  await transaction.recover(directory);
  if (await transaction.committed(directory))
    return { status: "committed", reasons: [] };
  const legacy = await lstat(path.join(directory, sourceFile)).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    },
  );
  if (!legacy) return { status: "unchanged", reasons: [] };
  const before = await snapshot(directory).catch(() => undefined);
  if (!before)
    return { status: "deferred", reasons: ["settings-files-unreadable"] };
  const inspected = await inspect(directory);
  if (inspected.blockers.length)
    return { status: "deferred", reasons: inspected.blockers };
  if (
    !inspected.regions.some(
      ({ key }) => key === "copy" || key === "same" || key === "target-only",
    )
  )
    return { status: "unchanged", reasons: [] };
  const issue = safeMode ? "plugin-safe-mode" : await packageIssue(directory);
  if (issue) return { status: "deferred", reasons: [issue] };
  const plan = propose(before, inspected);
  await transaction.prepare(directory, before, plan.changes);
  try {
    await transaction.resume(directory);
    // Fresh owning stores validate the new bytes before committing; no live
    // caches exist yet. The next app construction sees only this complete state.
    const after = await inspect(directory);
    if (
      after.blockers.length ||
      propose(await snapshot(directory), after).changes.size ||
      (await packageIssue(directory))
    )
      throw new Error(`${label} migration validation failed`);
    await transaction.commit(directory);
    return { status: "migrated", reasons: [] };
  } catch {
    await transaction.recover(directory);
    throw new Error(
      `${label} settings migration failed; original settings restored`,
    );
  }
}
