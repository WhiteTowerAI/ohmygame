import {
  inspectMediaMigration,
  type MediaMigrationMapping,
} from "./media-migration-inspection.js";
import { proposeMediaSettings } from "./media-settings-proposal.js";
import type { Snapshot } from "./elevenlabs-settings-snapshot.js";
import { ElevenLabsSettingsStore } from "./elevenlabs-settings.js";

// Reviewed Beta 0.1.0 identities; future models need a separate compatibility review.
export const ELEVENLABS_MIGRATION_MAPPINGS = [
  {
    source: "elevenlabs",
    target: "plugin.ohmygame.elevenlabs.elevenlabs",
    field: "apiKey",
    sourceField: "apiKey",
    audioModels: [
      { id: "eleven_v4", kinds: ["speech"] },
      { id: "eleven_flash_v2_5", kinds: ["speech"] },
      { id: "eleven_text_to_sound_v3", kinds: ["sound-effect"] },
      { id: "eleven_text_to_sound_v2", kinds: ["sound-effect"] },
      { id: "music_v2_5", kinds: ["music"] },
      { id: "music_v1", kinds: ["music"] },
      { id: "scribe_v2", kinds: [] },
    ],
  },
] as const satisfies readonly (MediaMigrationMapping<"elevenlabs"> & {
  sourceField: string;
})[];

/** Read only: no installation, settings writes, model remapping or vendor requests. */
export function inspectElevenLabsMigration(directory: string) {
  return inspectMediaMigration(
    directory,
    "ohmygame/elevenlabs",
    new ElevenLabsSettingsStore(directory),
    ELEVENLABS_MIGRATION_MAPPINGS,
  );
}

/** Build from the exact inspected snapshot; applying it is a separate guarded transaction. */
export function proposeElevenLabsSettings(
  original: Snapshot,
  inspected: Awaited<ReturnType<typeof inspectElevenLabsMigration>>,
) {
  const proposal = proposeMediaSettings(
    original,
    inspected,
    "elevenlabs.json",
    "ohmygame/elevenlabs",
    ELEVENLABS_MIGRATION_MAPPINGS,
  );
  const bytes =
    proposal.changes.get("model-visibility.json") ??
    original.get("model-visibility.json");
  const preferences = bytes
    ? JSON.parse(bytes.toString("utf8"))
    : { version: 1, hidden: {} };
  const before = JSON.stringify(preferences);
  const counts = {
    ...proposal.counts,
    defaultSpeechModel: false,
    defaultSoundEffectModel: false,
    defaultMusicModel: false,
  };
  for (const [kind, field] of [
    ["speech", "defaultSpeechModel"],
    ["sound-effect", "defaultSoundEffectModel"],
    ["music", "defaultMusicModel"],
  ] as const) {
    const mapped = inspected.defaultAudioModels?.[kind];
    if (mapped?.action !== "map") continue;
    // Preserve unknown fields on each saved reference; only the provider changes.
    preferences[field] = { ...preferences[field], provider: mapped.target };
    counts[field] = true;
  }
  if (JSON.stringify(preferences) !== before)
    proposal.changes.set(
      "model-visibility.json",
      Buffer.from(`${JSON.stringify(preferences, null, 2)}\n`),
    );
  return { changes: proposal.changes, counts };
}
