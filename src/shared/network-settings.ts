export type NetworkProxyMode = "auto" | "manual" | "direct";

export interface NetworkSettings {
  mode: NetworkProxyMode;
  proxyUrl: string;
  noProxy: string;
}

export interface EffectiveNetworkProxy {
  source: "environment" | "system" | "manual" | "direct";
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
  warning?: string;
}

export interface NetworkSettingsState {
  settings: NetworkSettings;
  active: EffectiveNetworkProxy;
  detected: EffectiveNetworkProxy;
  requiresRestart: boolean;
  systemProxyAvailable: boolean;
}

export interface NetworkConnectionTest {
  reachable: boolean;
  target: string;
  route: EffectiveNetworkProxy;
  statusCode?: number;
  elapsedMs: number;
  error?: string;
}

export const SYSTEM_PROXY_TARGET = "https://api.openai.com";
export const NETWORK_TEST_URL = `${SYSTEM_PROXY_TARGET}/v1/models`;
export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  mode: "auto",
  proxyUrl: "",
  noProxy: "",
};
