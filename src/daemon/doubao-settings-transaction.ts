import { createSettingsTransaction } from "./media-settings-transaction.js";
import { FILES } from "./doubao-settings-snapshot.js";

// All three native stores are immutable, including legacy files absent from this profile.
// compat: since beta.5.8, remove from beta.7 and 2026-12-18 after retained migration obligations are resolved.
export const SETTINGS_TRANSACTION_FILE = ".doubao-settings-transaction.json";
export const SETTINGS_TRANSACTION_BACKUP = ".doubao-settings-committed-v1.json";
export const {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  recoverInterruptedSettings: recoverInterruptedDoubaoSettings,
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  forgetSettingsTransaction,
} = createSettingsTransaction({
  files: FILES,
  sources: [
    "doubao-voice.json",
    "volcengine-tts.json",
    "volcengine-seed-audio.json",
  ],
  journal: SETTINGS_TRANSACTION_FILE,
  backup: SETTINGS_TRANSACTION_BACKUP,
  label: "Doubao",
});
