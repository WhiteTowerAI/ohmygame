import type { ProviderSummary } from "../shared/contracts.js";

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
