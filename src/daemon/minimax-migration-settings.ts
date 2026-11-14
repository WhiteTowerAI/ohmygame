// Read-only settings preflight shared by startup migration and inspection.
import type { File, Snapshot } from "./minimax-settings-snapshot.js";
import { MinimaxSettingsStore } from "./minimax-settings.js";
import { inspectMediaMigration } from "./media-migration-inspection.js";

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

/** Reads only settings; never loads projects or calls a vendor. */
export function inspectMinimaxMigration(dataDirectory: string) {
  return inspectMediaMigration(dataDirectory, "ohmygame/minimax", new MinimaxSettingsStore(dataDirectory),
    MINIMAX_MIGRATION_REGIONS.map((region) => ({ ...region, videoModels: MODELS })));
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
