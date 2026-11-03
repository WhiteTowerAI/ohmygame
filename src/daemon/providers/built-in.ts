import {
  DOUBAO_SEED_AUDIO_PROVIDER_NAME,
  DOUBAO_SPEECH_PROVIDER_NAME,
} from "../../shared/audio.js";
import type { DoubaoVoiceSettingsStore } from "../doubao-voice-settings.js";
import type { MediaProviderKeyStore } from "../media-provider-settings.js";
import { MINIMAX_PROVIDER_IDS, MINIMAX_PROVIDERS } from "../minimax-models.js";
import type { MinimaxSettingsStore } from "../minimax-settings.js";
import {
  SEEDANCE_PROVIDER_IDS,
  SEEDANCE_PROVIDERS,
} from "../seedance-models.js";
import type { SeedanceSettingsStore } from "../seedance-settings.js";
import { VolcengineSeedAudioProvider } from "../volcengine-seed-audio-provider.js";
import { VolcengineTtsProvider } from "../volcengine-tts-provider.js";
import type { MediaProviderEntry } from "./registry.js";

/** The stores that keep each built-in provider's key, and what their adapters need. */
export interface BuiltInProviderSources {
  /** Each native 3D service with its display name and key store. */
  native3D: readonly (readonly [
    id: string,
    name: string,
    settings: MediaProviderKeyStore,
  ])[];
  seedance: SeedanceSettingsStore;
  minimax: MinimaxSettingsStore;
  doubaoVoice: DoubaoVoiceSettingsStore;
  /** Network function for the audio services, injectable by tests. */
  audioFetch?: typeof fetch;
  enabled: (providerId: string) => boolean;
}

/** Every media provider the daemon ships, each listed once. Adding one means adding a row here. */
export function builtInMediaProviders(
  sources: BuiltInProviderSources,
): MediaProviderEntry[] {
  return [
    ...sources.native3D.map(([id, name, settings]) => ({
      id,
      name,
      capabilities: ["3d"] as const,
      configured: () => settings.get().configured,
      clear: () => settings.clear(),
    })),
    ...SEEDANCE_PROVIDER_IDS.map((id) => ({
      id,
      name: SEEDANCE_PROVIDERS[id].name,
      // Volcengine Ark also serves Seedream images with the same key.
      capabilities:
        id === "volcengine-ark"
          ? (["image", "video"] as const)
          : (["video"] as const),
      configured: () => sources.seedance.get(id).configured,
      clear: () => sources.seedance.clear(id),
    })),
    ...MINIMAX_PROVIDER_IDS.map((id) => ({
      id,
      name: MINIMAX_PROVIDERS[id].name,
      capabilities: ["video"] as const,
      configured: () => sources.minimax.get(id).configured,
      clear: () => sources.minimax.clear(id),
    })),
    {
      id: "volcengine-tts",
      name: DOUBAO_SPEECH_PROVIDER_NAME,
      capabilities: ["audio"] as const,
      configured: () => Boolean(sources.doubaoVoice.key("volcengine-tts")),
      // Disconnecting one Doubao service keeps the other's key and the default voice.
      clear: () => sources.doubaoVoice.setService("volcengine-tts", null),
      audio: new VolcengineTtsProvider(
        () => sources.doubaoVoice.key("volcengine-tts"),
        sources.audioFetch,
        undefined,
        () => sources.enabled("volcengine-tts"),
        () => sources.doubaoVoice.defaultVoiceId(),
      ),
    },
    {
      id: "volcengine-seed-audio",
      name: DOUBAO_SEED_AUDIO_PROVIDER_NAME,
      capabilities: ["audio"] as const,
      configured: () =>
        Boolean(sources.doubaoVoice.key("volcengine-seed-audio")),
      clear: () =>
        sources.doubaoVoice.setService("volcengine-seed-audio", null),
      audio: new VolcengineSeedAudioProvider(
        () => sources.doubaoVoice.key("volcengine-seed-audio"),
        sources.audioFetch,
        undefined,
        () => sources.enabled("volcengine-seed-audio"),
      ),
    },
  ];
}
