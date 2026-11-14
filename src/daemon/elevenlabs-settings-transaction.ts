import { createSettingsTransaction } from "./media-settings-transaction.js";
import { FILES } from "./elevenlabs-settings-snapshot.js";

// Separate receipts retain ownership of the native audio settings.
export const SETTINGS_TRANSACTION_FILE =
  ".elevenlabs-settings-transaction.json";
export const SETTINGS_TRANSACTION_BACKUP =
  ".elevenlabs-settings-committed-v1.json";
export const {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  recoverInterruptedSettings: recoverInterruptedElevenLabsSettings,
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  forgetSettingsTransaction,
} = createSettingsTransaction({
  files: FILES,
  sources: ["elevenlabs.json"],
  journal: SETTINGS_TRANSACTION_FILE,
  backup: SETTINGS_TRANSACTION_BACKUP,
  label: "ElevenLabs",
});
