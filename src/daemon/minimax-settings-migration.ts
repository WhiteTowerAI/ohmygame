import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { minimaxMigrationPackageIssue } from "./minimax-migration-package.js";
import {
  inspectMinimaxMigration,
  proposeMinimaxSettings,
} from "./minimax-migration-settings.js";
import { snapshot } from "./minimax-settings-snapshot.js";
import {
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  prepareSettingsTransaction,
  recoverInterruptedMinimaxSettings,
  resumeSettingsTransaction,
} from "./minimax-settings-transaction.js";

/**
 * compat: since beta.5.8, remove from beta.7 and 2026-12-14. Legacy MiniMax
 * settings become optional-plugin settings at the exclusive startup boundary.
 * Keep the source for legacy job execution; never rewrite or resubmit a job.
 * The caller owns the profile and has not constructed any settings consumers.
 */
export async function migrateMinimaxSettings(
  directory: string,
  safeMode = false,
): Promise<{
  status: "unchanged" | "deferred" | "migrated" | "committed";
  reasons: string[];
}> {
  directory = await realpath(directory);
  await recoverInterruptedMinimaxSettings(directory);
  if (await hasCommittedSettingsTransaction(directory))
    return { status: "committed", reasons: [] };
  const legacy = await lstat(path.join(directory, "minimax.json")).catch(
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined;
      throw cause;
    },
  );
  if (!legacy) return { status: "unchanged", reasons: [] };
  const before = await snapshot(directory).catch(() => undefined);
  if (!before)
    return { status: "deferred", reasons: ["settings-files-unreadable"] };
  const inspected = await inspectMinimaxMigration(directory);
  if (inspected.blockers.length)
    return { status: "deferred", reasons: inspected.blockers };
  if (
    !inspected.regions.some(
      ({ key }) => key === "copy" || key === "same" || key === "target-only",
    )
  )
    return { status: "unchanged", reasons: [] };
  const issue = safeMode
    ? "plugin-safe-mode"
    : await minimaxMigrationPackageIssue(directory);
  if (issue) return { status: "deferred", reasons: [issue] };
  const plan = proposeMinimaxSettings(before, inspected);
  await prepareSettingsTransaction(directory, before, plan.changes);
  try {
    await resumeSettingsTransaction(directory);
    // Fresh owning stores validate the new bytes before committing; no live
    // caches exist yet. The next app construction sees only this complete state.
    const after = await inspectMinimaxMigration(directory);
    if (
      after.blockers.length ||
      proposeMinimaxSettings(await snapshot(directory), after).changes.size ||
      (await minimaxMigrationPackageIssue(directory))
    )
      throw new Error("MiniMax migration validation failed");
    await commitSettingsTransaction(directory);
    return { status: "migrated", reasons: [] };
  } catch {
    await recoverInterruptedMinimaxSettings(directory);
    throw new Error(
      "MiniMax settings migration failed; original settings restored",
    );
  }
}
