// Read-only settings preflight shared by media-provider migration inspectors.
import { stat } from "node:fs/promises";
import path from "node:path";
import { PluginValues } from "./plugin-values.js";
import { ProviderModelSettingsStore } from "./provider-model-settings.js";

export interface MediaMigrationMapping<Source extends string> {
  source: Source;
  target: string;
  field: string;
  imageModels?: readonly string[];
  videoModels: readonly string[];
}

/** Reads only these three stores. Never starts the app, loads projects or calls a vendor. */
export async function inspectMediaMigration<Source extends string>(
  dataDirectory: string,
  pluginId: string,
  legacy: { load(): Promise<void>; key(source: Source): string | undefined },
  mappings: readonly MediaMigrationMapping<Source>[],
) {
  const directory = await stat(dataDirectory).catch(() => undefined);
  if (!directory?.isDirectory())
    throw new Error("An existing app data directory is required");
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

  const regions = mappings.map(
    ({ source, target, field, imageModels = [], videoModels }) => {
      const models = [...imageModels, ...videoModels];
      const stored = pluginReadable
        ? plugin.storedSecret(pluginId, field)
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
          (id) => !models.includes(id),
        ).length;
        const unknownTargetModels = to.hiddenModelIds.filter(
          (id) => !models.includes(id),
        ).length;
        const same =
          from.enabled === to.enabled &&
          models.every(
            (id) =>
              from.hiddenModelIds.includes(id) ===
              to.hiddenModelIds.includes(id),
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
            hiddenModels: models.filter((id) =>
              from.hiddenModelIds.includes(id),
            ),
            unknownModels: unknownSourceModels,
          },
          target: {
            configured: to.configured,
            enabled: to.enabled,
            hiddenModels: models.filter((id) => to.hiddenModelIds.includes(id)),
            unknownModels: unknownTargetModels,
          },
        };
      }
      return { source, target, key, visibility };
    },
  );

  const inspectDefault = (kind: "image" | "video") => {
    const current = preferencesReadable
      ? kind === "image"
        ? preferences.defaultImageModel()
        : preferences.defaultVideoModel()
      : undefined;
    const mapping =
      current && mappings.find(({ source }) => source === current.provider);
    const models =
      mapping &&
      (kind === "image" ? (mapping.imageModels ?? []) : mapping.videoModels);
    const result = !preferencesReadable
      ? { action: "blocked" }
      : !current
        ? { action: "absent" }
        : !mapping
          ? { action: "unchanged" }
          : !models!.includes(current.id)
            ? { action: "unsupported-model" }
            : {
                action: "map",
                source: mapping.source,
                target: mapping.target,
                model: current.id,
              };
    if (result.action === "unsupported-model")
      blockers.push(`default-${kind}-model-unsupported`);
    return result;
  };
  const defaultVideoModel = inspectDefault("video");
  const defaultImageModel = mappings.some(
    ({ imageModels }) => imageModels !== undefined,
  )
    ? inspectDefault("image")
    : undefined;

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
    ...(defaultImageModel ? { defaultImageModel } : {}),
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
