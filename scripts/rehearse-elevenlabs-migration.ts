// Exercises settings migration on a disposable copy, never on the supplied data.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rehearseSettingsMigration } from "./rehearse-media-settings.js";
import { inspectElevenLabsMigration } from "./inspect-elevenlabs-migration.js";
import { snapshot, same } from "../src/daemon/elevenlabs-settings-snapshot.js";
import {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  forgetSettingsTransaction,
} from "../src/daemon/elevenlabs-settings-transaction.js";
import { proposeElevenLabsSettings } from "../src/daemon/elevenlabs-migration-settings.js";

export function rehearseElevenLabsMigration(dataDirectory: string) {
  return rehearseSettingsMigration(dataDirectory, {
    name: "elevenlabs",
    snapshot,
    same,
    inspect: inspectElevenLabsMigration,
    propose: proposeElevenLabsSettings,
    emptyCounts: {
      keys: 0,
      providerPreferences: 0,
      defaultVideoModel: false,
      defaultImageModel: false,
      defaultSpeechModel: false,
      defaultSoundEffectModel: false,
      defaultMusicModel: false,
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
        "Usage: bun run rehearse:elevenlabs-migration --data-dir <copied-app-data-directory>",
      );
    else if (!values["data-dir"]) {
      console.error("Required: --data-dir <copied-app-data-directory>");
      process.exitCode = 2;
    } else {
      const report = await rehearseElevenLabsMigration(
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
