import {
  DOUBAO_SPEECH_PROVIDER_ID,
  DOUBAO_SPEECH_PROVIDER_NAME,
} from "../../shared/audio.js";
import { DoubaoSpeechProvider } from "../doubao-speech-provider.js";
import type { DoubaoVoiceSettingsStore } from "../doubao-voice-settings.js";
import {
  ELEVENLABS_PROVIDER_NAME,
  ElevenLabsAudioProvider,
} from "../elevenlabs-audio-provider.js";
import type { ElevenLabsSettingsStore } from "../elevenlabs-settings.js";
import type { MediaProviderKeyStore } from "../media-provider-settings.js";
import { MINIMAX_PROVIDER_IDS, MINIMAX_PROVIDERS } from "../minimax-models.js";
import type { MinimaxSettingsStore } from "../minimax-settings.js";
import {
  SEEDANCE_PROVIDER_IDS,
  SEEDANCE_PROVIDERS,
} from "../seedance-models.js";
import type { SeedanceSettingsStore } from "../seedance-settings.js";
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
  elevenLabs: ElevenLabsSettingsStore;
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
      id: DOUBAO_SPEECH_PROVIDER_ID,
      name: DOUBAO_SPEECH_PROVIDER_NAME,
      capabilities: ["audio"] as const,
      configured: () => sources.doubaoVoice.get().configured,
      clear: () => sources.doubaoVoice.clear(),
      audio: new DoubaoSpeechProvider({
        key: (service) => sources.doubaoVoice.key(service),
        defaultVoiceId: () => sources.doubaoVoice.defaultVoiceId(),
        enabled: () => sources.enabled(DOUBAO_SPEECH_PROVIDER_ID),
        request: sources.audioFetch,
      }),
    },
    {
      id: "elevenlabs",
      name: ELEVENLABS_PROVIDER_NAME,
      capabilities: ["audio"] as const,
      // Disconnected through its own credential route, so it has no `clear` here.
      configured: () => Boolean(sources.elevenLabs.key()),
      audio: new ElevenLabsAudioProvider(
        () => sources.elevenLabs.key(),
        sources.audioFetch,
        () => sources.enabled("elevenlabs"),
      ),
    },
  ];
}
