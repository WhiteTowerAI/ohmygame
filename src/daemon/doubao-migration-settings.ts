import path from "node:path";
import {
  AUDIO_KINDS,
  AUDIO_VOICE_ID_MAX_LENGTH,
  AUDIO_VOICE_ID_PATTERN,
} from "../shared/audio.js";
import { keyAction } from "./media-migration-inspection.js";
import { snapshot, same, type Snapshot } from "./media-settings-snapshot.js";
import { PluginValues } from "./plugin-values.js";
import { ProviderModelSettingsStore } from "./provider-model-settings.js";

export const DOUBAO_MIGRATION_FILES = [
  "doubao-voice.json",
  "volcengine-tts.json",
  "volcengine-seed-audio.json",
  "plugin-store/configuration.json",
  "model-visibility.json",
] as const;
export const DOUBAO_MIGRATION_MAPPINGS = [
  { source: "volcengine-tts", model: "seed-tts-2.0", kinds: ["speech"] },
  {
    source: "volcengine-seed-audio",
    model: "seed-audio-1.0",
    kinds: ["speech", "sound-effect", "music"],
  },
] as const;
const pluginId = "ohmygame/doubao-voice";
const target = "plugin.ohmygame.doubao-voice.doubao-voice";
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const voiceValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= AUDIO_VOICE_ID_MAX_LENGTH &&
  new RegExp(AUDIO_VOICE_ID_PATTERN).test(value);

/** Read-only preflight. Never load DoubaoVoiceSettingsStore: its load merges/deletes legacy files. */
export async function inspectDoubaoMigration(directory: string) {
  const before = await snapshot(directory, DOUBAO_MIGRATION_FILES);
  const { blockers, legacyReadable, keys, sourceVoice } =
    sourceSettings(before);
  const plugin = new PluginValues(
    path.join(directory, "plugin-store/configuration.json"),
  );
  const preferences = new ProviderModelSettingsStore(directory, directory);
  const loaded = await Promise.allSettled([plugin.load(), preferences.load()]);
  const pluginReadable = loaded[0].status === "fulfilled" && !plugin.readOnly;
  const preferencesReadable = loaded[1].status === "fulfilled";
  if (!pluginReadable) blockers.push("plugin-settings-unreadable");
  if (!preferencesReadable) blockers.push("model-preferences-unreadable");
  const stored = pluginReadable
    ? plugin.storedSecret(pluginId, "apiKey")
    : undefined;
  const connection = !legacyReadable
    ? "blocked"
    : Boolean(keys[0]) !== Boolean(keys[1])
      ? "separate-service-connection"
      : keys[0] && keys[0] !== keys[1]
        ? "distinct-service-keys"
        : "shared";
  if (
    connection === "separate-service-connection" ||
    connection === "distinct-service-keys"
  )
    blockers.push(connection);
  const key =
    !legacyReadable || !pluginReadable || connection !== "shared"
      ? "blocked"
      : keyAction(keys[0], stored?.value, stored?.occupied ?? false);
  if (key === "invalid" || key === "conflict") blockers.push(`key-${key}`);
  // The validated plugin store keeps type tags; don't reinterpret secrets/paths as a voice.
  const pluginBytes = before.get("plugin-store/configuration.json");
  const targetVoice =
    pluginReadable && pluginBytes
      ? JSON.parse(pluginBytes.toString("utf8")).plugins[pluginId]
          ?.defaultVoiceId
      : undefined;
  const voice =
    !legacyReadable || !pluginReadable
      ? "blocked"
      : (sourceVoice !== undefined && !voiceValid(sourceVoice)) ||
          (targetVoice !== undefined &&
            (targetVoice.type !== "text" || !voiceValid(targetVoice.value)))
        ? "invalid"
        : sourceVoice === undefined
          ? targetVoice
            ? "target-only"
            : "absent"
          : !targetVoice
            ? "copy"
            : targetVoice.value === sourceVoice
              ? "same"
              : "conflict";
  if (voice === "invalid" || voice === "conflict")
    blockers.push(`default-voice-${voice}`);
  const visibility = (() => {
    if (!preferencesReadable) return { action: "blocked" };
    const from = DOUBAO_MIGRATION_MAPPINGS.map((m) =>
      preferences.providerVisibility(m.source),
    );
    const to = preferences.providerVisibility(target);
    const unknownModels =
      from.reduce(
        (sum, item, i) =>
          sum +
          item.hiddenModelIds.filter(
            (id) => id !== DOUBAO_MIGRATION_MAPPINGS[i]!.model,
          ).length,
        0,
      ) +
      to.hiddenModelIds.filter(
        (id) => !DOUBAO_MIGRATION_MAPPINGS.some((m) => m.model === id),
      ).length;
    const hiddenModels = DOUBAO_MIGRATION_MAPPINGS.filter((m, i) =>
      from[i]!.hiddenModelIds.includes(m.model),
    ).map((m) => m.model);
    const action = unknownModels
      ? "unsupported-models"
      : from[0]!.enabled !== from[1]!.enabled
        ? "separate-service-switches"
        : !to.configured
          ? "copy"
          : to.enabled === from[0]!.enabled &&
              DOUBAO_MIGRATION_MAPPINGS.every(
                (m) =>
                  to.hiddenModelIds.includes(m.model) ===
                  hiddenModels.includes(m.model),
              )
            ? "same"
            : "review-target";
    if (!["copy", "same"].includes(action))
      blockers.push(`visibility-${action}`);
    return { action, enabled: from[0]!.enabled, hiddenModels, unknownModels };
  })();
  const defaultAudioModels = Object.fromEntries(
    AUDIO_KINDS.map((kind) => {
      if (!preferencesReadable) return [kind, { action: "blocked" }];
      const value = preferences.defaultMediaModel(kind);
      const mapping = DOUBAO_MIGRATION_MAPPINGS.find(
        (m) => m.source === value?.provider,
      );
      if (!value || !mapping)
        return [kind, { action: value ? "unchanged" : "absent" }];
      if (
        value.id !== mapping.model ||
        !mapping.kinds.some((k) => k === kind)
      ) {
        blockers.push(`default-${kind}-model-unsupported`);
        return [kind, { action: "unsupported-model" }];
      }
      return [
        kind,
        { action: "map", source: mapping.source, target, model: mapping.model },
      ];
    }),
  );
  if (
    !same(
      before,
      await snapshot(directory, DOUBAO_MIGRATION_FILES),
      DOUBAO_MIGRATION_FILES,
    )
  )
    throw new Error("Settings changed during inspection");
  // Fixed identifiers/booleans/counts only. Never return credentials, hashes, voices or arbitrary stored data.
  return {
    version: 1,
    scope: "settings-only",
    activation: "held",
    stores: {
      legacy: legacyReadable,
      plugin: pluginReadable,
      preferences: preferencesReadable,
    },
    connection,
    key,
    defaultVoice: voice,
    visibility,
    defaultAudioModels,
    blockers: [...new Set(blockers)],
    remainingChecks: [
      "live-generation-and-restart-acceptance",
      "integrity-pinned-package-and-grants",
      "saved-canvas-model-references",
      "unfinished-jobs-and-recovery-journals",
      "transactional-apply-and-rollback",
    ],
  };
}

function sourceSettings(before: Snapshot) {
  const blockers: string[] = [];
  let legacyReadable = true;
  const legacy = DOUBAO_MIGRATION_FILES.slice(0, 3).map((file, index) => {
    const bytes = before.get(file);
    if (!bytes) return undefined;
    try {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (
        !record(value) ||
        value.version !== 1 ||
        (value.apiKey !== undefined && typeof value.apiKey !== "string") ||
        (value.defaultVoiceId !== undefined &&
          typeof value.defaultVoiceId !== "string") ||
        (index === 0 &&
          (!record(value.services) ||
            Object.values(value.services).some(
              (v) => v !== null && typeof v !== "string",
            )))
      )
        throw new Error("Invalid source");
      const allowed =
        index === 0
          ? ["version", "apiKey", "services", "defaultVoiceId"]
          : index === 1
            ? ["version", "apiKey", "defaultVoiceId"]
            : ["version", "apiKey"];
      if (
        Object.keys(value).some((key) => !allowed.includes(key)) ||
        (record(value.services) &&
          Object.keys(value.services).some(
            (key) => !DOUBAO_MIGRATION_MAPPINGS.some((m) => m.source === key),
          ))
      )
        blockers.push("legacy-settings-unknown-fields");
      return value;
    } catch {
      legacyReadable = false;
      return undefined;
    }
  });
  if (!legacyReadable) blockers.push("legacy-settings-unreadable");
  const [current, oldTts, oldSeed] = legacy;
  const keys = DOUBAO_MIGRATION_MAPPINGS.map(({ source }, index) => {
    if (!legacyReadable) return undefined;
    if (!current)
      return (index === 0 ? oldTts : oldSeed)?.apiKey as string | undefined;
    const override = (current.services as Record<string, string | null>)[
      source
    ];
    return override === null
      ? undefined
      : (override ?? (current.apiKey as string | undefined));
  });
  const sourceVoice = legacyReadable
    ? (current?.defaultVoiceId ?? oldTts?.defaultVoiceId)
    : undefined;
  return { blockers, legacyReadable, keys, sourceVoice };
}

/** Build from the inspected snapshot. Native credentials/legacy stores remain byte-identical. */
export function proposeDoubaoSettings(
  original: Snapshot,
  inspected: Awaited<ReturnType<typeof inspectDoubaoMigration>>,
) {
  if (inspected.blockers.length)
    throw new Error("Doubao settings migration is blocked");
  const source = sourceSettings(original);
  if (!source.legacyReadable || source.blockers.length)
    throw new Error("Invalid Doubao migration source");
  const parse = (file: string, fallback: Record<string, unknown>) => {
    const bytes = original.get(file);
    return bytes ? JSON.parse(bytes.toString("utf8")) : fallback;
  };
  const configuration = parse("plugin-store/configuration.json", {
    version: 1,
    plugins: {},
  });
  const preferences = parse("model-visibility.json", {
    version: 1,
    hidden: {},
  });
  const beforeConfiguration = JSON.stringify(configuration),
    beforePreferences = JSON.stringify(preferences);
  const counts = {
    keys: 0,
    providerPreferences: 0,
    defaultVoice: false,
    defaultSpeechModel: false,
    defaultSoundEffectModel: false,
    defaultMusicModel: false,
  };
  if (inspected.key === "copy" || inspected.defaultVoice === "copy") {
    configuration.plugins = {
      ...configuration.plugins,
      [pluginId]: {
        ...configuration.plugins[pluginId],
        ...(inspected.key === "copy"
          ? { apiKey: { type: "secret", value: source.keys[0] } }
          : {}),
        ...(inspected.defaultVoice === "copy"
          ? { defaultVoiceId: { type: "text", value: source.sourceVoice } }
          : {}),
      },
    };
    counts.keys = inspected.key === "copy" ? 1 : 0;
    counts.defaultVoice = inspected.defaultVoice === "copy";
  }
  if (inspected.visibility.action === "copy") {
    preferences.hidden = {
      ...preferences.hidden,
      [target]: inspected.visibility.hiddenModels,
    };
    if (!inspected.visibility.enabled)
      preferences.disabled = [...(preferences.disabled ?? []), target];
    counts.providerPreferences = 1;
  }
  for (const [kind, field] of [
    ["speech", "defaultSpeechModel"],
    ["sound-effect", "defaultSoundEffectModel"],
    ["music", "defaultMusicModel"],
  ] as const) {
    if (inspected.defaultAudioModels[kind]?.action !== "map") continue;
    preferences[field] = { ...preferences[field], provider: target };
    counts[field] = true;
  }
  const changes: Snapshot<(typeof DOUBAO_MIGRATION_FILES)[number]> = new Map();
  if (JSON.stringify(configuration) !== beforeConfiguration)
    changes.set(
      "plugin-store/configuration.json",
      Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`),
    );
  if (JSON.stringify(preferences) !== beforePreferences)
    changes.set(
      "model-visibility.json",
      Buffer.from(`${JSON.stringify(preferences, null, 2)}\n`),
    );
  return { changes, counts };
}
