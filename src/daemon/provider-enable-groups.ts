interface ProviderEnablementGroup {
  ids: readonly string[];
  allowUnconfigured: boolean;
}

const HYPER3D_GROUP = ["hyper3d", "cloud-hyper3d"] as const;

const GROUPS: readonly ProviderEnablementGroup[] = [
  { ids: HYPER3D_GROUP, allowUnconfigured: true },
];

const groupByProviderId = new Map(
  GROUPS.flatMap((group) => group.ids.map((id) => [id, group] as const)),
);

/** All persisted switches that control a provider's availability. */
export function providerEnablementIds(providerId: string): readonly string[] {
  return groupByProviderId.get(providerId)?.ids ?? [providerId];
}

/** Whether a provider may be switched on before a credential is connected. */
export function canEnableUnconfiguredProvider(providerId: string): boolean {
  return groupByProviderId.get(providerId)?.allowUnconfigured ?? false;
}

/** A provider is available only when every switch in its enablement group is on. */
export function isProviderEnabled(
  providerId: string,
  isEnabled: (id: string) => boolean,
): boolean {
  return providerEnablementIds(providerId).every(isEnabled);
}
