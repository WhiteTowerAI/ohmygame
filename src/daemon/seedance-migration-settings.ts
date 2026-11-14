import { inspectMediaMigration } from "./media-migration-inspection.js";
import { SeedanceSettingsStore } from "./seedance-settings.js";

// Reviewed 0.1.0 adapter contract. Keep these IDs explicit: future built-in
// models must not become eligible for migration without reviewing the package.
export const SEEDANCE_MIGRATION_REGIONS = [
  {
    source: "volcengine-ark",
    target: "plugin.ohmygame.seedance.ark",
    field: "arkApiKey",
    imageModels: [
      "doubao-seedream-5-0-pro-260628",
      "doubao-seedream-5-0-flash-260915",
      "doubao-seedream-5-0-260128",
    ],
    videoModels: ["doubao-seedance-2-5-260628", "doubao-seedance-2-0-260128"],
  },
  {
    source: "byteplus-modelark",
    target: "plugin.ohmygame.seedance.byteplus",
    field: "byteplusApiKey",
    imageModels: [],
    videoModels: [
      "dreamina-seedance-2-5-260628",
      "dreamina-seedance-2-0-260128",
    ],
  },
] as const;

/** One Ark key owns both media kinds. Inspection never installs or enables a plugin. */
export function inspectSeedanceMigration(dataDirectory: string) {
  return inspectMediaMigration(
    dataDirectory,
    "ohmygame/seedance",
    new SeedanceSettingsStore(dataDirectory),
    SEEDANCE_MIGRATION_REGIONS,
  );
}
