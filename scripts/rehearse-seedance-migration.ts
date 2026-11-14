// Exercises settings migration on a disposable copy, never on the supplied data.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rehearseSettingsMigration } from "./rehearse-media-settings.js";
import { inspectSeedanceMigration } from "./inspect-seedance-migration.js";
import { snapshot, same } from "../src/daemon/seedance-settings-snapshot.js";
import {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  forgetSettingsTransaction,
} from "../src/daemon/seedance-settings-transaction.js";
import { proposeSeedanceSettings } from "../src/daemon/seedance-migration-settings.js";

export function rehearseSeedanceMigration(dataDirectory: string) {
  return rehearseSettingsMigration(dataDirectory, {
    name: "seedance",
    snapshot,
    same,
    inspect: inspectSeedanceMigration,
    propose: proposeSeedanceSettings,
    emptyCounts: {
      keys: 0,
      providerPreferences: 0,
      defaultVideoModel: false,
      defaultImageModel: false,
    },
    prepare: prepareSettingsTransaction,
    resume: resumeSettingsTransaction,
    rollback: rollbackSettingsTransaction,
    forget: forgetSettingsTransaction,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { "data-dir": { type: "string" }, help: { type: "boolean" } },
    });
    if (values.help)
      console.log(
        "Usage: bun run rehearse:seedance-migration --data-dir <copied-app-data-directory>",
      );
    else if (!values["data-dir"]) {
      console.error("Required: --data-dir <copied-app-data-directory>");
      process.exitCode = 2;
    } else {
      const report = await rehearseSeedanceMigration(
        path.resolve(values["data-dir"]),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "passed" ? 0 : 1;
    }
  } catch {
    console.error("Invalid rehearsal arguments; see --help.");
    process.exitCode = 2;
  }
}
