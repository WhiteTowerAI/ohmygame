import { createSettingsTransaction } from "./media-settings-transaction.js";
import { FILES } from "./minimax-settings-snapshot.js";

// Preserve the existing version-1 receipt path and bytes for restart recovery.
export const SETTINGS_TRANSACTION_FILE = ".minimax-settings-transaction.json";
export const SETTINGS_TRANSACTION_BACKUP = ".minimax-settings-committed-v1.json";
export const {
  prepareSettingsTransaction, resumeSettingsTransaction, rollbackSettingsTransaction,
  recoverInterruptedSettings: recoverInterruptedMinimaxSettings,
  commitSettingsTransaction, hasCommittedSettingsTransaction, forgetSettingsTransaction,
} = createSettingsTransaction({
  files: FILES, source: "minimax.json", journal: SETTINGS_TRANSACTION_FILE,
  backup: SETTINGS_TRANSACTION_BACKUP, label: "MiniMax",
});
