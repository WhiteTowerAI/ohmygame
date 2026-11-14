import { migrateMediaSettings } from "./media-settings-migration.js";
import { seedanceMigrationPackageIssue } from "./seedance-migration-package.js";
import {
  inspectSeedanceMigration,
  proposeSeedanceSettings,
} from "./seedance-migration-settings.js";
import { snapshot } from "./seedance-settings-snapshot.js";
import {
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  prepareSettingsTransaction,
  recoverInterruptedSeedanceSettings,
  resumeSettingsTransaction,
} from "./seedance-settings-transaction.js";

/**
 * compat: since beta.5.8, remove from beta.7 and 2026-12-14. Legacy Seedance
 * settings become optional-plugin settings at the exclusive startup boundary.
 * Keep the source for legacy job execution; never rewrite or resubmit a job.
 * The caller owns the profile and has not constructed any settings consumers.
 */
export function migrateSeedanceSettings(directory: string, safeMode = false) {
  return migrateMediaSettings(directory, safeMode, {
    sourceFile: "seedance.json",
    label: "Seedance",
    snapshot,
    inspect: inspectSeedanceMigration,
    propose: proposeSeedanceSettings,
    packageIssue: seedanceMigrationPackageIssue,
    transaction: {
      recover: recoverInterruptedSeedanceSettings,
      committed: hasCommittedSettingsTransaction,
      prepare: prepareSettingsTransaction,
      resume: resumeSettingsTransaction,
      commit: commitSettingsTransaction,
    },
  });
}
