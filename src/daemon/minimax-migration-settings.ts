// Read-only settings preflight shared by startup migration and inspection.
import type { File, Snapshot } from "./minimax-settings-snapshot.js";
import { stat } from "node:fs/promises";
import path from "node:path";
import { MinimaxSettingsStore } from "./minimax-settings.js";
import { PluginValues } from "./plugin-values.js";
import { ProviderModelSettingsStore } from "./provider-model-settings.js";

// The optional beta adapter's current contract. Recheck against the
// integrity-pinned package at activation; the release lock lives beside this file.
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
type Json = Record<string, unknown>;
const MODELS = ["MiniMax-H3", "MiniMax-H3-Max"];

/** Reads only these three stores. Never starts the app, loads projects or calls a vendor. */
export async function inspectMinimaxMigration(dataDirectory: string) {
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

  // Only fixed identifiers, booleans and counts leave this function. Never
  // return keys, key hashes, unknown metadata, parser errors or arbitrary IDs.
  return {
    version: 1,
    scope: "settings-only",
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

/** Called only after the owning stores accepted this exact copied snapshot. */
export function proposeMinimaxSettings(
  original: Snapshot,
  inspected: Awaited<ReturnType<typeof inspectMinimaxMigration>>,
) {
  const parse = (file: File, fallback: Json): Json => {
    const bytes = original.get(file);
    return bytes === undefined ? fallback : JSON.parse(bytes.toString("utf8"));
  };
  const keys = parse("minimax.json", { version: 1 });
  const configuration = parse("plugin-store/configuration.json", {
    version: 1,
    plugins: {},
  });
  const preferences = parse("model-visibility.json", {
    version: 1,
    hidden: {},
  });
  const configurationBefore = JSON.stringify(configuration),
    preferencesBefore = JSON.stringify(preferences);
  const counts = { keys: 0, providerPreferences: 0, defaultVideoModel: false };
  for (const region of inspected.regions) {
    const field = MINIMAX_MIGRATION_REGIONS.find(
      ({ source }) => source === region.source,
    )!.field;
    if (region.key === "copy") {
      const plugins = configuration.plugins as Record<string, Json>;
      configuration.plugins = {
        ...plugins,
        "ohmygame/minimax": {
          ...plugins["ohmygame/minimax"],
          [field]: { type: "secret", value: keys[field] },
        },
      };
      counts.keys++;
    }
    if (region.visibility?.action === "copy") {
      const before = JSON.stringify(preferences);
      const hidden = preferences.hidden as Record<string, string[]>;
      if (Object.hasOwn(hidden, region.source))
        preferences.hidden = {
          ...hidden,
          [region.target]: [...hidden[region.source]],
        };
      if (!region.visibility.source.enabled)
        preferences.disabled = [
          ...((preferences.disabled as string[]) ?? []),
          region.target,
        ];
      if (before !== JSON.stringify(preferences)) counts.providerPreferences++;
    }
  }
  if (inspected.defaultVideoModel.action === "map") {
    // Unlike a normal user selection, a provider rename must retain reference metadata.
    preferences.defaultVideoModel = {
      ...(preferences.defaultVideoModel as Json),
      provider: inspected.defaultVideoModel.target,
    };
    counts.defaultVideoModel = true;
  }
  const changes: Snapshot = new Map();
  if (JSON.stringify(configuration) !== configurationBefore)
    changes.set(
      "plugin-store/configuration.json",
      Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`),
    );
  if (JSON.stringify(preferences) !== preferencesBefore)
    changes.set(
      "model-visibility.json",
      Buffer.from(`${JSON.stringify(preferences, null, 2)}\n`),
    );
  return { changes, counts };
}
