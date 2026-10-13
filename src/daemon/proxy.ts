// Use the installed implementation; Bun's built-in undici shim omits dispatcher lifecycle APIs.
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici/index.js";
import type { EffectiveNetworkProxy, NetworkSettings } from "../shared/network-settings.js";

const PROXY_VARIABLES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];

export function networkBypassList(input: string): string {
  const entries = input.split(",").map((entry) => entry.trim()).filter(Boolean);
  // Undici recognizes the all-hosts wildcard only when it is the entire list.
  if (entries.includes("*")) return "*";
  return [...new Set([...entries, "127.0.0.1", "localhost", ".localhost", "::1", "[::1]"])].join(",");
}

export function normalizeProxyUrl(input: string, allowCredentials = false): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    try { url = new URL(`http://${input.trim()}`); } catch { throw new Error("Enter a valid HTTP or HTTPS proxy URL"); }
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || (!allowCredentials && (url.username || url.password)) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS proxy URL without credentials, a path, or query parameters");
  }
  return url.toString().replace(/\/$/, "");
}

export function proxyUrlsFromEnvironment(env: NodeJS.ProcessEnv): { httpProxy: string; httpsProxy: string } | undefined {
  const httpProxy = value(env.HTTP_PROXY) ?? value(env.http_proxy) ?? value(env.HTTPS_PROXY) ?? value(env.https_proxy);
  const httpsProxy = value(env.HTTPS_PROXY) ?? value(env.https_proxy) ?? httpProxy;
  if (!httpProxy || !httpsProxy) return undefined;

  return { httpProxy, httpsProxy };
}

export function resolveNetworkProxy(settings: NetworkSettings, env: NodeJS.ProcessEnv, systemProxy?: string): EffectiveNetworkProxy {
  const noProxy = networkBypassList(settings.mode === "auto" ? `${value(env.NO_PROXY) ?? value(env.no_proxy) ?? ""},${settings.noProxy}` : settings.noProxy);
  if (settings.mode === "direct") return { source: "direct", noProxy };
  if (settings.mode === "manual") {
    const proxyUrl = normalizeProxyUrl(settings.proxyUrl);
    return { source: "manual", httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy };
  }
  const inherited = proxyUrlsFromEnvironment(env);
  if (inherited) {
    return { source: "environment", httpProxy: normalizeProxyUrl(inherited.httpProxy, true), httpsProxy: normalizeProxyUrl(inherited.httpsProxy, true), noProxy };
  }
  const proxyUrl = systemProxy ? proxyUrlFromElectron(systemProxy) : undefined;
  if (proxyUrl) return { source: "system", httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy };
  return {
    source: "direct", noProxy,
    ...(systemProxy === "UNAVAILABLE"
      ? { warning: "Could not detect the system proxy. Choose Manual proxy to set an HTTP or Mixed port." }
      : systemProxy && /SOCKS/i.test(systemProxy) && !/^\s*DIRECT\b/i.test(systemProxy)
      ? { warning: "The system proxy uses SOCKS. Choose the HTTP or Mixed port in Manual proxy, or use Clash TUN." }
      : env.ALL_PROXY || env.all_proxy
        ? { warning: "ALL_PROXY is not supported. Set HTTP_PROXY / HTTPS_PROXY, or choose Manual proxy." }
        : {}),
  };
}

/** Proxy credentials inherited from the environment stay in the host processes. */
export function publicNetworkProxy(proxy: EffectiveNetworkProxy): EffectiveNetworkProxy {
  const redact = (value: string | undefined) => {
    if (!value) return undefined;
    const url = new URL(value); url.username = ""; url.password = "";
    return url.toString().replace(/\/$/, "");
  };
  return { ...proxy, ...(proxy.httpProxy ? { httpProxy: redact(proxy.httpProxy) } : {}), ...(proxy.httpsProxy ? { httpsProxy: redact(proxy.httpsProxy) } : {}) };
}

export function createNetworkDispatcher(proxy: EffectiveNetworkProxy): Dispatcher {
  return proxy.httpProxy && proxy.httpsProxy
    ? new EnvHttpProxyAgent({ httpProxy: proxy.httpProxy, httpsProxy: proxy.httpsProxy, noProxy: proxy.noProxy })
    : new Agent();
}

/** Normalize both cases so SDKs and new child processes agree with the fetch dispatcher. */
export function applyNetworkProxyEnvironment(environment: NodeJS.ProcessEnv, proxy: EffectiveNetworkProxy): void {
  for (const key of PROXY_VARIABLES) delete environment[key];
  environment.NO_PROXY = environment.no_proxy = proxy.noProxy;
  if (proxy.httpProxy) environment.HTTP_PROXY = environment.http_proxy = proxy.httpProxy;
  if (proxy.httpsProxy) environment.HTTPS_PROXY = environment.https_proxy = proxy.httpsProxy;
}

export function activateNetworkProxy(proxy: EffectiveNetworkProxy, environment: NodeJS.ProcessEnv = process.env): Dispatcher {
  const dispatcher = createNetworkDispatcher(proxy);
  setGlobalDispatcher(dispatcher);
  applyNetworkProxyEnvironment(environment, proxy);
  return dispatcher;
}

function proxyUrlFromElectron(input: string): string | undefined {
  for (const entry of input.split(";")) {
    const [type, address] = entry.trim().split(/\s+/, 2);
    const proxyType = type?.toUpperCase();
    if (proxyType === "DIRECT") return undefined;
    const protocol = proxyType === "PROXY" ? "http" : proxyType === "HTTPS" ? "https" : undefined;
    if (!protocol || !address) continue;
    try { return normalizeProxyUrl(`${protocol}://${address}`); }
    catch { /* Skip unsupported or invalid entries in the system proxy result. */ }
  }
  return undefined;
}

function value(input: string | undefined): string | undefined {
  const normalized = input?.trim();
  return normalized || undefined;
}
