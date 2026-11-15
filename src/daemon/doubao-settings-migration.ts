import { migrateMediaSettings } from "./media-settings-migration.js";
import { doubaoMigrationPackageIssue } from "./doubao-migration-package.js";
import {
  inspectDoubaoMigration,
  proposeDoubaoSettings,
} from "./doubao-migration-settings.js";
import { snapshot } from "./doubao-settings-snapshot.js";
import {
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  prepareSettingsTransaction,
  recoverInterruptedDoubaoSettings,
  resumeSettingsTransaction,
} from "./doubao-settings-transaction.js";

/**
 * compat: since beta.5.8, remove from beta.7 and 2026-12-15 after retained
 * profile/task obligations are resolved. Caller owns the profile exclusively
 * before settings consumers exist. Production startup does not call this yet.
 * Native key bytes and historical paid tasks retain their original ownership.
 */
export function migrateDoubaoSettings(directory: string, safeMode = false) {
  return migrateMediaSettings(directory, safeMode, {
    sourceFiles: [
      "doubao-voice.json",
      "volcengine-tts.json",
      "volcengine-seed-audio.json",
    ],
    hasConfiguration: (report) =>
      ["copy", "same", "target-only"].includes(report.key),
    label: "Doubao",
    snapshot,
    inspect: inspectDoubaoMigration,
    propose: proposeDoubaoSettings,
    packageIssue: doubaoMigrationPackageIssue,
    transaction: {
      recover: recoverInterruptedDoubaoSettings,
      committed: hasCommittedSettingsTransaction,
      prepare: prepareSettingsTransaction,
      resume: resumeSettingsTransaction,
      commit: commitSettingsTransaction,
    },
  });
}
