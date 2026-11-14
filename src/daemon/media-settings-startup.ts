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
  // These transactions share configuration and preferences with image/video.
  // Recover even in safe mode or before a 3D package is approved for activation.
  for (const provider of ["meshy", "tripo", "hyper3d"] as const)
    await model3DSettingsTransaction(provider).recoverInterruptedSettings(directory);
  const minimax = await migrateMinimaxSettings(directory, safeMode);
  const seedance = await migrateSeedanceSettings(directory, safeMode);
  return { minimax, seedance };
}
