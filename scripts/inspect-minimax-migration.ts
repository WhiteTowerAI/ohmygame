// Read-only preparation. There is deliberately no apply or activation path.
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MinimaxSettingsStore } from "../src/daemon/minimax-settings.js";
import { PluginValues } from "../src/daemon/plugin-values.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";

// The optional beta adapter's current contract. Recheck against the
// integrity-pinned package before implementing activation; this is not a lock.
export const MINIMAX_MIGRATION_REGIONS = [
  {
    source: "minimax-video-cn",
    target: "plugin.ohmygame.minimax.cn",
    field: "cnApiKey",
  },
  {
    source: "minimax-video-global",
    target: "plugin.ohmygame.minimax.global",
    field: "globalApiKey",
  },
] as const;
const MODELS = ["MiniMax-H3", "MiniMax-H3-Max"];

/** Reads only these three stores. Never starts the app, loads projects or calls a vendor. */
export async function inspectMinimaxMigration(
  dataDirectory: string,
  workspaces: readonly string[] = [],
) {
  const directory = await stat(dataDirectory).catch(() => undefined);
  if (!directory?.isDirectory())
    throw new Error("An existing app data directory is required");
  const legacy = new MinimaxSettingsStore(dataDirectory);
  const plugin = new PluginValues(
    path.join(dataDirectory, "plugin-store", "configuration.json"),
  );
  // load() reads model-visibility.json only; the agent directory is not accessed.
  const preferences = new ProviderModelSettingsStore(
    dataDirectory,
    dataDirectory,
  );
  const [legacyReadable, pluginLoaded, preferencesReadable] = await Promise.all(
    [
      readable(() => legacy.load()),
      readable(() => plugin.load()),
      readable(() => preferences.load()),
    ],
  );
  const pluginReadable = pluginLoaded && !plugin.readOnly;
  const blockers: string[] = [];
  if (!legacyReadable) blockers.push("legacy-settings-unreadable");
  if (!pluginReadable) blockers.push("plugin-settings-unreadable");
  if (!preferencesReadable) blockers.push("model-preferences-unreadable");

  const regions = MINIMAX_MIGRATION_REGIONS.map(({ source, target, field }) => {
    const stored = pluginReadable
      ? plugin.storedSecret("ohmygame/minimax", field)
      : undefined;
    const key =
      !legacyReadable || !pluginReadable
        ? "blocked"
        : keyAction(
            legacy.key(source),
            stored?.value,
            stored?.occupied ?? false,
          );
    if (key === "conflict" || key === "invalid")
      blockers.push(`${source}:key-${key}`);
    let visibility = null;
    if (preferencesReadable) {
      const from = preferences.providerVisibility(source);
      const to = preferences.providerVisibility(target);
      const unknownSourceModels = from.hiddenModelIds.filter(
        (id) => !MODELS.includes(id),
      ).length;
      const unknownTargetModels = to.hiddenModelIds.filter(
        (id) => !MODELS.includes(id),
      ).length;
      const same =
        from.enabled === to.enabled &&
        MODELS.every(
          (id) =>
            from.hiddenModelIds.includes(id) === to.hiddenModelIds.includes(id),
        );
      const action =
        unknownSourceModels || unknownTargetModels
          ? "unsupported-models"
          : !to.configured
            ? "copy"
            : same
              ? "same"
              : "review-target";
      if (action === "unsupported-models" || action === "review-target")
        blockers.push(`${source}:visibility-${action}`);
      visibility = {
        action,
        source: {
          enabled: from.enabled,
          hiddenModels: MODELS.filter((id) => from.hiddenModelIds.includes(id)),
          unknownModels: unknownSourceModels,
        },
        target: {
          configured: to.configured,
          enabled: to.enabled,
          hiddenModels: MODELS.filter((id) => to.hiddenModelIds.includes(id)),
          unknownModels: unknownTargetModels,
        },
      };
    }
    return { source, target, key, visibility };
  });

  const current = preferencesReadable
    ? preferences.defaultVideoModel()
    : undefined;
  const region =
    current &&
    MINIMAX_MIGRATION_REGIONS.find(({ source }) => source === current.provider);
  const defaultVideoModel = !preferencesReadable
    ? { action: "blocked" }
    : !current
      ? { action: "absent" }
      : !region
        ? { action: "unchanged" }
        : !MODELS.includes(current.id)
          ? { action: "unsupported-model" }
          : {
              action: "map",
              source: current.provider,
              target: region.target,
              model: current.id,
            };
  if (defaultVideoModel.action === "unsupported-model")
    blockers.push("default-video-model-unsupported");

  const canvas = workspaces.length
    ? await (
        await import("./inspect-minimax-workspaces.js")
      ).inspectMinimaxWorkspaces(
        dataDirectory,
        workspaces,
        MINIMAX_MIGRATION_REGIONS,
        MODELS,
      )
    : undefined;
  if (canvas) blockers.push(...canvas.blockers);

  // Only fixed identifiers, booleans and counts leave this function. Never
  // return keys, key hashes, unknown metadata, parser errors or arbitrary IDs.
  return {
    version: canvas ? 2 : 1,
    scope: canvas ? "selected-workspaces" : "settings-only",
    ...(canvas ? { canvas } : {}),
    activation: "held",
    stores: {
      legacy: legacyReadable,
      plugin: pluginReadable,
      preferences: preferencesReadable,
    },
    regions,
    defaultVideoModel,
    blockers,
    remainingChecks: [
      "live-generation-and-restart-acceptance",
      "publication-authorization-and-integrity-pinned-package",
      "plugin-installation-and-enablement",
      "saved-canvas-model-references",
      "unfinished-jobs-and-recovery-journals",
      "transactional-apply-and-rollback",
    ],
  };
}

function keyAction(
  source: string | undefined,
  target: string | undefined,
  targetStored: boolean,
) {
  // Plugin fields have a smaller limit than the legacy key store. Never trim,
  // truncate or silently replace an occupied but incompatible target field.
  const valid = (value: string) =>
    value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
  if (
    (source !== undefined && source !== "" && !valid(source)) ||
    (targetStored && (!target || !valid(target)))
  )
    return "invalid";
  if (!source) return target ? "target-only" : "absent";
  return !target ? "copy" : source === target ? "same" : "conflict";
}

async function readable(load: () => Promise<void>): Promise<boolean> {
  try {
    await load();
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "data-dir": { type: "string" },
        workspace: { type: "string", multiple: true },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: bun run inspect:minimax-migration --data-dir <copied-app-data-directory> [--workspace <copied-project-directory>]...",
      );
    } else if (!values["data-dir"]) {
      console.error(
        "Required: --data-dir <copied-app-data-directory> [--workspace <copied-project-directory>]...",
      );
      process.exitCode = 2;
    } else {
      const report = await inspectMinimaxMigration(
        path.resolve(values["data-dir"]),
        values.workspace?.map((workspace) => path.resolve(workspace)),
      );
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.blockers.length ? 1 : 0;
    }
  } catch {
    // JSON and argument errors can contain secrets supplied as input.
    console.error(
      "Inspection failed. Check arguments and use an existing, readable app data directory.",
    );
    process.exitCode = 2;
  }
}
