import { migrateMediaSettings } from "./media-settings-migration.js";
import { elevenlabsMigrationPackageIssue } from "./elevenlabs-migration-package.js";
import {
  inspectElevenLabsMigration,
  proposeElevenLabsSettings,
} from "./elevenlabs-migration-settings.js";
import { snapshot } from "./elevenlabs-settings-snapshot.js";
import {
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  prepareSettingsTransaction,
  recoverInterruptedElevenLabsSettings,
  resumeSettingsTransaction,
} from "./elevenlabs-settings-transaction.js";

/**
 * compat: since beta.5.8, remove from beta.7 and 2026-12-15 after retained
 * profile/task obligations are resolved. Caller owns the profile exclusively
 * before settings consumers exist. Production startup does not call this yet.
 * Native key bytes and historical paid tasks retain their original ownership.
 */
export function migrateElevenLabsSettings(directory: string, safeMode = false) {
  return migrateMediaSettings(directory, safeMode, {
    sourceFile: "elevenlabs.json",
    label: "ElevenLabs",
    snapshot,
    inspect: inspectElevenLabsMigration,
    propose: proposeElevenLabsSettings,
    packageIssue: elevenlabsMigrationPackageIssue,
    transaction: {
      recover: recoverInterruptedElevenLabsSettings,
      committed: hasCommittedSettingsTransaction,
      prepare: prepareSettingsTransaction,
      resume: resumeSettingsTransaction,
      commit: commitSettingsTransaction,
    },
  });
}
