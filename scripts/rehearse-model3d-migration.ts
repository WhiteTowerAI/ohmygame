// Only a disposable settings copy is changed; there is intentionally no apply flag.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MODEL3D_MIGRATION_PACKAGES } from "../src/daemon/model3d-migration-package.js";
import {
  model3DSettingsFiles,
  proposeModel3DSettings,
} from "../src/daemon/model3d-migration-settings.js";
import { snapshot, same } from "../src/daemon/media-settings-snapshot.js";
import { createSettingsTransaction } from "../src/daemon/media-settings-transaction.js";
import { indexPluginPackage } from "../src/daemon/plugin-index.js";
import { rehearseSettingsMigration } from "./rehearse-media-settings.js";

type Provider = (typeof MODEL3D_MIGRATION_PACKAGES)[number]["provider"];
export async function rehearseModel3DMigration(
  dataDirectory: string,
  provider: Provider,
) {
  const pin = MODEL3D_MIGRATION_PACKAGES.find(
    (entry) => entry.provider === provider,
  );
  if (!pin) throw new Error("No reviewed 3D migration package");
  const root = path.resolve(
    import.meta.dirname,
    "..",
    ".runtime",
    `${pin.pluginId}-packages`,
    pin.version,
    "source",
  );
  const checked = await indexPluginPackage(root);
  if (
    !checked.ok ||
    checked.entry.digest !== pin.digest ||
    !checked.entry.manifest.beta
  )
    throw new Error("Prepare the reviewed migration package first");
  const media = checked.entry.manifest.contributes?.providers?.find(
    (entry) => entry.id === provider,
  )?.media?.["3d"];
  if (!media?.editableModels)
    throw new Error("No editable 3D models in the reviewed package");
  const files = model3DSettingsFiles(provider);
  const transaction = createSettingsTransaction({
    files,
    source: files[0],
    journal: `.${provider}-settings-transaction.json`,
    backup: `.${provider}-settings-committed-v1.json`,
    label: provider,
  });
  return rehearseSettingsMigration(dataDirectory, {
    name: provider,
    snapshot: (directory) => snapshot(directory, files),
    same: (a, b) => same(a, b, files),
    inspect: async (directory) => {
      const plan = await proposeModel3DSettings(
        await snapshot(directory, files),
        provider,
        media.models,
        media.processing?.id,
      );
      return { ...plan, blockers: plan.report.blockers };
    },
    propose: (_original, plan) => ({
      changes: plan.changes,
      counts: plan.counts,
    }),
    emptyCounts: {
      keys: 0,
      definitions: 0,
      providerPreferences: 0,
      defaultModel3D: false,
      modelStoreUpgrade: false,
    },
    prepare: transaction.prepareSettingsTransaction,
    resume: transaction.resumeSettingsTransaction,
    rollback: transaction.rollbackSettingsTransaction,
    forget: transaction.forgetSettingsTransaction,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "data-dir": { type: "string" },
        provider: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help)
      console.log(
        "Usage: bun run rehearse:3d-migration --provider <meshy|tripo> --data-dir <copied-app-data-directory>",
      );
    else if (
      !values["data-dir"] ||
      (values.provider !== "meshy" && values.provider !== "tripo")
    ) {
      console.error(
        "Required: --provider <meshy|tripo> --data-dir <copied-app-data-directory>",
      );
      process.exitCode = 2;
    } else {
      const report = await rehearseModel3DMigration(
        path.resolve(values["data-dir"]),
        values.provider,
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.status === "passed" ? 0 : 1;
    }
  } catch {
    console.error(
      "Rehearsal failed. Check arguments and prepare the reviewed plugin packages; see --help.",
    );
    process.exitCode = 2;
  }
}
