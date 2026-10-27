import type { ProviderSummary } from "../shared/contracts.js";
import { DOUBAO_VOICE_PROVIDER_NAME } from "../shared/audio.js";

/** Providers listed ahead of the rest in Settings and first-run setup, in display order. */
const POPULAR_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "deepseek",
  "meshy",
  "tripo",
];

export interface ProviderGroups {
  /** Every working connection, including free cloud and local services. */
  connected: ProviderSummary[];
  free: ProviderSummary[];
  popular: ProviderSummary[];
  local: ProviderSummary[];
  more: ProviderSummary[];
}

/** One settings connection; service IDs remain stable in models and saved nodes. */
export function withDoubaoConnection(providers: readonly ProviderSummary[]): ProviderSummary[] {
  const seed = providers.find((provider) => provider.id === "volcengine-seed-audio");
  return providers.filter((provider) => provider.id !== "volcengine-seed-audio").map((provider) => provider.id === "volcengine-tts" ? {
    ...provider, name: DOUBAO_VOICE_PROVIDER_NAME, configured: provider.configured || Boolean(seed?.configured), status: provider.configured || seed?.configured ? "connected" : "not_configured",
    enabled: provider.enabled !== false || Boolean(seed && seed.enabled !== false),
  } : provider);
}

/** Splits providers into the groups both provider lists show, keeping each group's order stable. */
export function groupProviders(
  providers: readonly ProviderSummary[],
  {
    isConnected,
    isFree,
    isLocal,
  }: {
    isConnected: (provider: ProviderSummary) => boolean;
    isFree: (provider: ProviderSummary) => boolean;
    isLocal: (provider: ProviderSummary) => boolean;
  },
): ProviderGroups {
  providers = withDoubaoConnection(providers);
  const connected = providers.filter(isConnected);
  const remaining = providers.filter((provider) => !isConnected(provider));
  const free = remaining.filter(isFree);
  const local = remaining.filter(
    (provider) => !isFree(provider) && isLocal(provider),
  );
  const rest = remaining.filter(
    (provider) => !isFree(provider) && !isLocal(provider),
  );
  const popular = rest
    .filter((provider) => POPULAR_PROVIDER_IDS.includes(provider.id))
    .sort(
      (first, second) =>
        POPULAR_PROVIDER_IDS.indexOf(first.id) -
        POPULAR_PROVIDER_IDS.indexOf(second.id),
    );
  const more = rest.filter((provider) => !popular.includes(provider));
  return { connected, free, popular, local, more };
}
