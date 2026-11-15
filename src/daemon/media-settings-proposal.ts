import type { Snapshot } from "./media-settings-snapshot.js";
import type { inspectMediaMigration } from "./media-migration-inspection.js";
type Json = Record<string, unknown>;

/** Called only after the owning stores accepted this exact copied snapshot. */
export function proposeMediaSettings(
  original: Snapshot,
  inspected: Awaited<ReturnType<typeof inspectMediaMigration>>,
  sourceFile: string,
  pluginId: string,
  mappings: readonly { source: string; field: string; sourceField: string }[],
) {
  const parse = (file: string, fallback: Json): Json => {
    const bytes = original.get(file);
    return bytes === undefined ? fallback : JSON.parse(bytes.toString("utf8"));
  };
  const keys = parse(sourceFile, { version: 1 });
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
  const counts = {
    keys: 0,
    providerPreferences: 0,
    defaultVideoModel: false,
    defaultImageModel: false,
  };
  for (const region of inspected.regions) {
    const { field, sourceField } = mappings.find(
      ({ source }) => source === region.source,
    )!;
    if (region.key === "copy") {
      const plugins = configuration.plugins as Record<string, Json>;
      configuration.plugins = {
        ...plugins,
        [pluginId]: {
          ...plugins[pluginId],
          [field]: { type: "secret", value: keys[sourceField] },
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
  for (const field of ["defaultImageModel", "defaultVideoModel"] as const) {
    const mapped = inspected[field];
    if (mapped?.action !== "map") continue;
    // A provider rename retains unknown metadata on the saved reference.
    preferences[field] = {
      ...(preferences[field] as Json),
      provider: mapped.target,
    };
    counts[field] = true;
  }
  const changes: Map<
    "plugin-store/configuration.json" | "model-visibility.json",
    Buffer | undefined
  > = new Map();
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
