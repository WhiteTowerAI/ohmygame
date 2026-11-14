import {
  inspectMediaMigration,
  type MediaMigrationMapping,
} from "./media-migration-inspection.js";
import { ElevenLabsSettingsStore } from "./elevenlabs-settings.js";

// Reviewed Beta 0.1.0 identities; future models need a separate compatibility review.
export const ELEVENLABS_MIGRATION_MAPPINGS = [
  {
    source: "elevenlabs",
    target: "plugin.ohmygame.elevenlabs.elevenlabs",
    field: "apiKey",
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
] as const satisfies readonly MediaMigrationMapping<"elevenlabs">[];

/** Read only: no installation, settings writes, model remapping or vendor requests. */
export function inspectElevenLabsMigration(directory: string) {
  return inspectMediaMigration(
    directory,
    "ohmygame/elevenlabs",
    new ElevenLabsSettingsStore(directory),
    ELEVENLABS_MIGRATION_MAPPINGS,
  );
}
