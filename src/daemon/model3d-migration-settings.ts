import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Model3DDefinition } from "../shared/contracts.js";
import {
  model3DPreset,
  type Native3DProviderId,
} from "../shared/model3d-presets.js";
import {
  pluginMediaModelProblem,
  type PluginMediaModels,
} from "../shared/plugin-manifest.js";
import { keyAction } from "./media-migration-inspection.js";
import { equal, type Snapshot } from "./media-settings-snapshot.js";
import { PluginValues } from "./plugin-values.js";
import { PluginMediaModelChoices } from "./plugin-media-models.js";
import { ProviderModelSettingsStore } from "./provider-model-settings.js";

type Model = PluginMediaModels["3d"];
type Json = Record<string, any>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function model3DSettingsFiles(provider: Native3DProviderId) {
  return [
    `${provider}.json`,
    "plugin-store/configuration.json",
    "model-visibility.json",
    "plugin-media-models.json",
  ] as const;
}
type SettingsFile = ReturnType<typeof model3DSettingsFiles>[number];

/** Explicit conversion of native generation behavior; processing remains a separate connection. */
export function pluginModel3DDefinition(
  provider: Native3DProviderId,
  definition: Model3DDefinition,
): Model {
  const { id, name, settings } = definition;
  const model: Model = {
    id,
    title: name,
    operations: ["text", "image"],
    optionProfile: provider,
    polycount: {
      ...settings.polycount,
      presets: [...settings.polycount.presets],
    },
    maxReferenceImages: settings.maxReferenceImages,
    texture: settings.supportsTexture,
    pbr: settings.supportsPbr,
    defaults: structuredClone(
      settings.defaults ?? { texture: settings.supportsTexture, pbr: false },
    ),
    ...(provider === "meshy"
      ? {
          modelSettings: {
            imageOperation: settings.operation,
            modelType: settings.modelType,
          },
        }
      : {}),
  };
  if (pluginMediaModelProblem("3d", model))
    throw new Error("unsupported-model-definition");
  return model;
}

function sameModel(a: Model, b: Model) {
  // Adapter data and other plugin-owned metadata remain on the target. Never replace them.
  // An omitted title displays the model ID; it is not a conflicting user choice.
  if ((a.title || a.id) !== (b.title || b.id)) return false;
  const keys = [
    "id",
    "operations",
    "optionProfile",
    "polycount",
    "maxReferenceImages",
    "texture",
    "pbr",
    "defaults",
    "modelSettings",
  ] as const;
  return keys.every((key) => isDeepStrictEqual(a[key], b[key]));
}
const sameIds = (a: string[], b: string[]) =>
  isDeepStrictEqual([...new Set(a)].sort(), [...new Set(b)].sort());

/** Validates and plans an immutable snapshot on a private temporary copy. Never opens the supplied profile. */
export async function proposeModel3DSettings(
  original: Snapshot,
  provider: Native3DProviderId,
  models: readonly Model[],
  processingId = "connection",
) {
  const files = model3DSettingsFiles(provider);
  const target = `plugin.ohmygame.${provider}.${provider}`,
    pluginId = `ohmygame/${provider}`;
  const counts = {
    keys: 0,
    definitions: 0,
    providerPreferences: 0,
    defaultModel3D: false,
    modelStoreUpgrade: false,
  };
  const report = {
    version: 1,
    scope: "settings-only",
    activation: "held",
    provider,
    key: "blocked",
    blockers: [] as string[],
    proposed: counts,
  };
  const changes: Snapshot<SettingsFile> = new Map();
  let directory: string | undefined;
  let stage = "legacy-settings-unreadable";
  const parse = (file: string, fallback: Json): Json => {
    const bytes = original.get(file);
    const value: unknown =
      bytes === undefined ? fallback : JSON.parse(bytes.toString("utf8"));
    if (!record(value)) throw new Error("Invalid settings object");
    return value;
  };
  try {
    const legacy = parse(files[0], { version: 1 });
    if (
      legacy.version !== 1 ||
      (legacy.apiKey !== undefined && typeof legacy.apiKey !== "string")
    )
      throw new Error("Invalid legacy settings");
    directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-3d-settings-plan-"),
    );
    for (const file of files) {
      const bytes = original.get(file);
      if (bytes === undefined) continue;
      const location = path.join(directory, file);
      await mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
      await writeFile(location, bytes, { mode: 0o600 });
    }
    // Reuse each store's current parser on this exact snapshot, not a second read of live data.
    stage = "plugin-settings-unreadable";
    const configuration = new PluginValues(path.join(directory, files[1]));
    await configuration.load();
    if (configuration.readOnly) throw new Error("Invalid plugin settings");
    stage = "model-preferences-unreadable";
    const preferences = new ProviderModelSettingsStore(directory, directory);
    await preferences.load();
    stage = "plugin-models-unreadable";
    const choices = new PluginMediaModelChoices(directory);
    const choice = await choices.get(target, "3d");
    const preferenceData = parse(files[2], { version: 1, hidden: {} });
    const originalChoices = parse(files[3], { version: 2, providers: {} });
    const rawChoice = originalChoices.providers[target]?.["3d"];
    const storedKey = configuration.storedSecret(pluginId, "apiKey");
    report.key = keyAction(legacy.apiKey, storedKey.value, storedKey.occupied);
    if (report.key === "invalid" || report.key === "conflict")
      report.blockers.push(`key-${report.key}`);
    const sourceVisibility = preferences.providerVisibility(provider);
    const targetVisibility = preferences.providerVisibility(target);
    const targetHidden = [...targetVisibility.hiddenModelIds, ...choice.hidden];
    const targetConfigured =
      targetVisibility.configured || rawChoice !== undefined;
    if (
      targetConfigured &&
      (!sameIds(sourceVisibility.hiddenModelIds, targetHidden) ||
        sourceVisibility.enabled !== targetVisibility.enabled)
    )
      report.blockers.push("visibility-conflict");

    const definitions = structuredClone(choice.definitions ?? []);
    const sourceDefinitions = preferences.models3D(provider);
    const rawDefinitions: Json[] =
      preferenceData.nativeModels3D?.[provider] ?? [];
    const modelIds = new Set(models.map((model) => model.id));
    stage = "unsupported-model-definition";
    for (const raw of rawDefinitions) {
      // Do not silently drop newer behavior fields while translating into a different contract.
      if (
        Object.keys(raw).some(
          (key) => !["id", "name", "settings"].includes(key),
        ) ||
        Object.keys(raw.settings).some(
          (key) =>
            ![
              "protocol",
              "baseUrl",
              "operation",
              "operations",
              "modelType",
              "maxReferenceImages",
              "polycount",
              "supportsTexture",
              "supportsPbr",
              "defaults",
            ].includes(key),
        ) ||
        Object.keys(raw.settings.polycount).some(
          (key) => !["min", "max", "default", "presets"].includes(key),
        ) ||
        Object.keys(raw.settings.defaults ?? {}).some(
          (key) => !["texture", "pbr"].includes(key),
        )
      ) {
        report.blockers.push("unsupported-model-definition");
        continue;
      }
      const definition = sourceDefinitions.find(
        (model) => model.id === raw.id.trim(),
      )!;
      const converted = pluginModel3DDefinition(provider, definition);
      if (converted.id === processingId) {
        report.blockers.push("processing-model-conflict");
        continue;
      }
      const preset = models.find((model) => model.id === converted.id);
      // A new native preset requires reviewing the plugin, rather than silently making it custom.
      if (model3DPreset(provider, converted.id) && !preset) {
        report.blockers.push("unsupported-model-definition");
        continue;
      }
      const existing =
        definitions.find((entry) => entry.model.id === converted.id)?.model ??
        choice.added.find((entry) => entry.id === converted.id);
      if (existing) {
        if (!sameModel(existing, converted))
          report.blockers.push("model-definition-conflict");
      } else if (!preset || !sameModel(preset, converted)) {
        definitions.push({
          custom: !preset,
          model: { ...structuredClone(preset ?? {}), ...converted },
        });
        counts.definitions++;
      }
      modelIds.add(converted.id);
    }
    const currentDefault = preferenceData.defaultModel3D;
    if (
      currentDefault?.provider === provider &&
      !modelIds.has(currentDefault.id)
    )
      report.blockers.push("default-model-unsupported");
    report.blockers = [...new Set(report.blockers)];
    if (report.blockers.length) return { report, changes, counts };

    stage = "proposal-validation-failed";
    const configData = parse(files[1], { version: 1, plugins: {} });
    if (report.key === "copy") {
      configData.plugins[pluginId] = {
        ...configData.plugins[pluginId],
        apiKey: { type: "secret", value: legacy.apiKey },
      };
      counts.keys++;
    }
    if (!targetConfigured && sourceVisibility.configured) {
      if (!sourceVisibility.enabled)
        preferenceData.disabled = [...(preferenceData.disabled ?? []), target];
      counts.providerPreferences++;
    }
    if (currentDefault?.provider === provider) {
      preferenceData.defaultModel3D = { ...currentDefault, provider: target };
      counts.defaultModel3D = true;
    }
    const needsChoice =
      counts.definitions > 0 ||
      (!targetConfigured && sourceVisibility.configured);
    if (needsChoice)
      await choices.update(target, "3d", (before) => ({
        ...before,
        definitions,
        hidden: targetConfigured
          ? before.hidden
          : [...sourceVisibility.hiddenModelIds],
      }));
    const add = (file: SettingsFile, before: Json, after: Json) => {
      if (!isDeepStrictEqual(before, after))
        changes.set(file, Buffer.from(`${JSON.stringify(after, null, 2)}\n`));
    };
    add(files[1], parse(files[1], { version: 1, plugins: {} }), configData);
    add(files[2], parse(files[2], { version: 1, hidden: {} }), preferenceData);
    const modelBytes = await readFile(path.join(directory, files[3])).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (!equal(original.get(files[3]), modelBytes))
      changes.set(files[3], modelBytes);
    counts.modelStoreUpgrade =
      originalChoices.version === 1 && modelBytes !== undefined;
    // Validate exactly the planned bytes with the owning stores before exposing a proposal.
    for (const [file, bytes] of changes)
      if (bytes) {
        await mkdir(path.dirname(path.join(directory, file)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(path.join(directory, file), bytes, { mode: 0o600 });
      }
    await configuration.load();
    if (configuration.readOnly) throw new Error("Invalid target configuration");
    await preferences.load();
    await new PluginMediaModelChoices(directory).get(target, "3d");
    return { report, changes, counts };
  } catch {
    report.blockers = [...new Set([...report.blockers, stage])];
    return { report, changes: new Map() as Snapshot<SettingsFile>, counts };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
