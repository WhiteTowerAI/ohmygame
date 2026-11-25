import { migrateDoubaoSettings } from "./doubao-settings-migration.js";
import { recoverInterruptedDoubaoSettings } from "./doubao-settings-transaction.js";
import { migrateElevenLabsSettings } from "./elevenlabs-settings-migration.js";
import { recoverInterruptedElevenLabsSettings } from "./elevenlabs-settings-transaction.js";
import { migrateModel3DSettings } from "./model3d-settings-migration.js";
import { model3DSettingsTransaction } from "./model3d-settings-transaction.js";
import { migrateMinimaxSettings } from "./minimax-settings-migration.js";
import { recoverInterruptedMinimaxSettings } from "./minimax-settings-transaction.js";
import { migrateSeedanceSettings } from "./seedance-settings-migration.js";
import { recoverInterruptedSeedanceSettings } from "./seedance-settings-transaction.js";

/** Recover every prior attempt before a new migration touches shared configuration. */
export async function migrateMediaSettingsAtStartup(
  directory: string,
  safeMode = false,
) {
  await recoverInterruptedMinimaxSettings(directory);
  await recoverInterruptedSeedanceSettings(directory);
  await recoverInterruptedElevenLabsSettings(directory);
  await recoverInterruptedDoubaoSettings(directory);
  // These transactions share configuration and preferences with image/video.
  // Recover even in safe mode or before a 3D package is approved for activation.
  for (const provider of ["meshy", "tripo", "hyper3d"] as const)
    await model3DSettingsTransaction(provider).recoverInterruptedSettings(directory);
  const minimax = await migrateMinimaxSettings(directory, safeMode);
  const seedance = await migrateSeedanceSettings(directory, safeMode);
  const elevenlabs = await migrateElevenLabsSettings(directory, safeMode);
  const doubao = await migrateDoubaoSettings(directory, safeMode);
  const meshy = await migrateModel3DSettings(directory, "meshy", safeMode);
  // Tripo 0.1.0 cannot download current vendor outputs. Honor a sealed commit
  // from an earlier build without starting a new migration to that package.
  const tripo = await model3DSettingsTransaction("tripo").committedMigration(directory);
  return { minimax, seedance, elevenlabs, doubao, meshy, tripo };
}
