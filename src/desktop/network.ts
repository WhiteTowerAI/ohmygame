import type { Session } from "electron";
import { isIP } from "node:net";
import {
  SYSTEM_PROXY_TARGET,
  type EffectiveNetworkProxy,
} from "../shared/network-settings.js";
import { NetworkSettingsStore } from "../daemon/network-settings.js";
import { publicNetworkProxy, resolveNetworkProxy } from "../daemon/proxy.js";

export function electronProxyConfig(
  proxy: EffectiveNetworkProxy,
): Parameters<Session["setProxy"]>[0] {
  if (!proxy.httpProxy || !proxy.httpsProxy) return { mode: "direct" };
  const bypass = proxy.noProxy.split(",").flatMap((host) => {
    if (host === "::1") return [];
    const withPort = host.match(/^(.+):(\d+)$/);
    const hostname = (withPort ? withPort[1] : host).replace(/^\*?\./, "");
    const port = withPort ? `:${withPort[2]}` : "";
    if (hostname === "*" || isIP(hostname.replace(/^\[|\]$/g, "")))
      return [host];
    // Undici also bypasses subdomains for bare NO_PROXY hostnames.
    return [`${hostname}${port}`, `*.${hostname}${port}`];
  });
  const publicProxy = publicNetworkProxy(proxy);
  return {
    mode: "fixed_servers",
    proxyRules: `http=${publicProxy.httpProxy};https=${publicProxy.httpsProxy}`,
    proxyBypassRules: [...new Set(bypass)].join(";"),
  };
}

export function proxyCredentials(
  proxy: EffectiveNetworkProxy,
  host: string,
  port: number,
): { username: string; password: string } | undefined {
  for (const value of [proxy.httpProxy, proxy.httpsProxy]) {
    if (!value) continue;
    const url = new URL(value);
    if (
      (url.username || url.password) &&
      url.hostname === host &&
      Number(url.port || (url.protocol === "https:" ? 443 : 80)) === port
    ) {
      return {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    }
  }
  return undefined;
}

export async function prepareDesktopNetwork(options: {
  dataDirectory: string;
  environment: NodeJS.ProcessEnv;
  resolveProxy: (url: string) => Promise<string>;
}): Promise<{ environment: NodeJS.ProcessEnv; active: EffectiveNetworkProxy }> {
  const store = new NetworkSettingsStore(options.dataDirectory);
  await store.load();
  let systemProxy = "DIRECT";
  try {
    systemProxy = await options.resolveProxy(SYSTEM_PROXY_TARGET);
  } catch {
    systemProxy = "UNAVAILABLE";
  }
  const active = resolveNetworkProxy(
    store.get(),
    options.environment,
    systemProxy,
  );
  return {
    environment: { ...options.environment, OHMYGAME_SYSTEM_PROXY: systemProxy },
    active,
  };
}
