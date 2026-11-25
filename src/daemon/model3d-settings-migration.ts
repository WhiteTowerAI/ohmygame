import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { Native3DProviderId } from "../shared/model3d-presets.js";
import { checkModel3DMigrationPackage } from "./model3d-migration-package.js";
import {
  model3DSettingsTransaction,
  model3DTransactionFiles,
  proposeModel3DTransaction,
  type CommittedModel3DMigration,
} from "./model3d-settings-transaction.js";
import { snapshot } from "./media-settings-snapshot.js";

type Result =
  | { status: "unchanged" | "deferred"; reasons: string[] }
  | {
      status: "migrated" | "committed";
      reasons: [];
      migration: CommittedModel3DMigration;
    };

/**
 * Startup activation for an installed, reviewed 3D provider.
 * The caller owns the profile, has recovered every other provider transaction,
 * and has not constructed live settings consumers. No vendor request is made.
 * compat: since beta.5.8, remove from beta.7 and 2026-12-18 after native retirement.
 */
export async function migrateModel3DSettings(
  directory: string,
  provider: Native3DProviderId,
  safeMode = false,
): Promise<Result> {
  directory = await realpath(directory);
  const transaction = model3DSettingsTransaction(provider);
  await transaction.recoverInterruptedSettings(directory);
  const committed = await transaction.committedMigration(directory);
  // A later uninstall, key reset or safe-mode restart cannot restore native ownership.
  if (committed)
    return { status: "committed", reasons: [], migration: committed };
  const deferred = (...reasons: string[]): Result => ({
    status: "deferred",
    reasons,
  });
  if (safeMode) return deferred("plugin-safe-mode");
  const checked = await checkModel3DMigrationPackage(directory, provider);
  if (checked.issue === "plugin-not-installed") {
    const native = await lstat(path.join(directory, `${provider}.json`)).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    });
    if (!native) return { status: "unchanged", reasons: [] };
  }
  if (!checked.manifest) return deferred(checked.issue);
  const media = checked.manifest.contributes?.providers?.find(
    (entry) => entry.id === provider,
  )?.media?.["3d"];
  if (!media?.editableModels) return deferred("plugin-models-unavailable");
  const files = model3DTransactionFiles(provider);
  const before = await snapshot(directory, files).catch(() => undefined);
  if (!before) return deferred("settings-files-unreadable");
  const plan = await proposeModel3DTransaction(before, provider, media);
  if (plan.report.blockers.length) return deferred(...plan.report.blockers);
  if (!["copy", "same", "target-only"].includes(plan.report.key))
    return { status: "unchanged", reasons: [] };
  await transaction.prepareSettingsTransaction(directory, before, plan.changes);
  try {
    await transaction.resumeSettingsTransaction(directory);
    // Reload owning stores from the applied bytes and require an idempotent plan
    // before sealing settings, reference identities and original recovery parameters.
    const after = await proposeModel3DTransaction(
      await snapshot(directory, files),
      provider,
      media,
    );
    if (
      after.report.blockers.length ||
      after.changes.size ||
      (await checkModel3DMigrationPackage(directory, provider)).issue
    )
      throw new Error("3D migration validation failed");
    await transaction.commitSettingsTransaction(directory);
  } catch {
    await transaction.recoverInterruptedSettings(directory);
    throw new Error("3D settings migration failed; original settings restored");
  }
  const migration = await transaction.committedMigration(directory);
  if (!migration) throw new Error("Committed 3D settings migration is missing");
  return { status: "migrated", reasons: [], migration };
}
