import { createSettingsTransaction } from "./media-settings-transaction.js";
import { FILES } from "./seedance-settings-snapshot.js";

// Separate receipts retain ownership of the shared Ark and independent BytePlus settings.
export const SETTINGS_TRANSACTION_FILE = ".seedance-settings-transaction.json";
export const SETTINGS_TRANSACTION_BACKUP =
  ".seedance-settings-committed-v1.json";
export const {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  recoverInterruptedSettings: recoverInterruptedSeedanceSettings,
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  forgetSettingsTransaction,
} = createSettingsTransaction({
  files: FILES,
  source: "seedance.json",
  journal: SETTINGS_TRANSACTION_FILE,
  backup: SETTINGS_TRANSACTION_BACKUP,
  label: "Seedance",
});
