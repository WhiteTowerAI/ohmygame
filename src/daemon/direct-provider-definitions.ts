import type { ProviderCapability, ProviderSummary } from "../shared/contracts.js";
import { DOUBAO_SPEECH_PROVIDER_ID, DOUBAO_SPEECH_PROVIDER_NAME } from "../shared/audio.js";
import type { DoubaoVoiceSettingsStore } from "./doubao-voice-settings.js";
import type { MediaProviderKeyStore } from "./media-provider-settings.js";
import { MINIMAX_PROVIDER_IDS, MINIMAX_PROVIDERS, type MinimaxProviderId } from "./minimax-models.js";
import type { MinimaxSettingsStore } from "./minimax-settings.js";
import { SEEDANCE_PROVIDER_IDS, SEEDANCE_PROVIDERS, type SeedanceProviderId } from "./seedance-models.js";
import type { SeedanceSettingsStore } from "./seedance-settings.js";

export interface DirectProviderDefinition {
  readonly id: string;
  summary(): ProviderSummary;
  removeCredentials(): Promise<void>;
}

interface Options {
  native3DProviders: readonly (readonly [string, string, MediaProviderKeyStore])[];
  seedanceSettings: SeedanceSettingsStore;
  minimaxSettings: MinimaxSettingsStore;
  doubaoVoiceSettings: DoubaoVoiceSettingsStore;
  isEnabled: (id: string) => boolean;
}

/** Built-in providers whose credentials live in daemon-owned settings files. */
export function createDirectProviderDefinitions(options: Options): readonly DirectProviderDefinition[] {
  const { native3DProviders, seedanceSettings, minimaxSettings, doubaoVoiceSettings, isEnabled } = options;
  return [
    ...native3DProviders.map(([id, name, settings]) => definition(id, name, () => settings.get().configured, ["3d"], isEnabled, () => settings.clear())),
    ...SEEDANCE_PROVIDER_IDS.map((id) => seedanceDefinition(id, seedanceSettings, isEnabled)),
    ...MINIMAX_PROVIDER_IDS.map((id) => minimaxDefinition(id, minimaxSettings, isEnabled)),
    definition(DOUBAO_SPEECH_PROVIDER_ID, DOUBAO_SPEECH_PROVIDER_NAME, () => doubaoVoiceSettings.get().configured, ["audio"], isEnabled, () => doubaoVoiceSettings.clear()),
  ];
}

function seedanceDefinition(id: SeedanceProviderId, settings: SeedanceSettingsStore, isEnabled: Options["isEnabled"]): DirectProviderDefinition {
  const provider = SEEDANCE_PROVIDERS[id];
  return definition(id, provider.name, () => settings.get(id).configured, id === "volcengine-ark" ? ["image", "video"] : ["video"], isEnabled, () => settings.clear(id));
}

function minimaxDefinition(id: MinimaxProviderId, settings: MinimaxSettingsStore, isEnabled: Options["isEnabled"]): DirectProviderDefinition {
  return definition(id, MINIMAX_PROVIDERS[id].name, () => settings.get(id).configured, ["video"], isEnabled, () => settings.clear(id));
}

function definition(id: string, name: string, configured: () => boolean, capabilities: ProviderCapability[], isEnabled: Options["isEnabled"], removeCredentials: () => Promise<void>): DirectProviderDefinition {
  return {
    id,
    summary: () => {
      const connected = configured();
      return {
        id, name, configured: connected, enabled: isEnabled(id), custom: false,
        status: connected ? "connected" : "not_configured",
        methods: [{ type: "api_key", label: `${name} API key` }],
        credentialType: "api_key", capabilities,
      };
    },
    removeCredentials,
  };
}
