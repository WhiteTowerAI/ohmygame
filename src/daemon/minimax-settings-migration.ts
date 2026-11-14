import { migrateMediaSettings } from "./media-settings-migration.js";
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
export function migrateMinimaxSettings(directory: string, safeMode = false) {
  return migrateMediaSettings(directory, safeMode, {
    sourceFile: "minimax.json", label: "MiniMax", snapshot,
    inspect: inspectMinimaxMigration, propose: proposeMinimaxSettings,
    packageIssue: minimaxMigrationPackageIssue,
    transaction: {
      recover: recoverInterruptedMinimaxSettings, committed: hasCommittedSettingsTransaction,
      prepare: prepareSettingsTransaction, resume: resumeSettingsTransaction, commit: commitSettingsTransaction,
    },
  });
}
