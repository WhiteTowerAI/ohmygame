import type { ProviderSummary, SaveCustomProviderRequest } from "../shared/contracts.js";

export const LOCAL_MODEL_PROVIDERS = {
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434/v1", api: "openai-completions", authentication: "none", preset: "ollama" },
  lmstudio: { name: "LM Studio", baseUrl: "http://localhost:1234/v1", api: "openai-completions", authentication: "none", preset: "lmstudio" },
} as const satisfies Record<string, SaveCustomProviderRequest>;

export type LocalModelProviderId = keyof typeof LOCAL_MODEL_PROVIDERS;

export function isLocalModelProvider(provider: Pick<ProviderSummary, "preset">): provider is { preset: LocalModelProviderId } {
  return provider.preset === "ollama" || provider.preset === "lmstudio";
}

/** Saved connections keep their IDs and names; only missing local services get a setup entry. */
export function withLocalModelProviders(providers: ProviderSummary[]): ProviderSummary[] {
  const missing = Object.values(LOCAL_MODEL_PROVIDERS).filter((local) => !providers.some((provider) => provider.preset === local.preset));
  return [...providers, ...missing.map((local): ProviderSummary => ({
    id: local.preset, name: local.name, preset: local.preset, custom: false,
    configured: false, status: "not_configured", methods: [], capabilities: ["language"],
  }))];
}
