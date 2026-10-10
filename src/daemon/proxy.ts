import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export interface ProxyOptions {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

let configuredProxy: ProxyOptions | undefined;

export function getConfiguredNetworkProxy(): ProxyOptions | undefined {
  return configuredProxy ? { ...configuredProxy } : undefined;
}

export function proxyOptionsFromEnvironment(env: NodeJS.ProcessEnv): ProxyOptions | undefined {
  const httpProxy = value(env.HTTP_PROXY) ?? value(env.http_proxy) ?? value(env.HTTPS_PROXY) ?? value(env.https_proxy);
  const httpsProxy = value(env.HTTPS_PROXY) ?? value(env.https_proxy) ?? httpProxy;
  if (!httpProxy || !httpsProxy) return undefined;

  const exclusions = new Set(
    (value(env.NO_PROXY) ?? value(env.no_proxy) ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  exclusions.add("127.0.0.1");
  exclusions.add("localhost");
  exclusions.add(".localhost");

  return { httpProxy, httpsProxy, noProxy: [...exclusions].join(",") };
}

export function configureNetworkProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  const options = proxyOptionsFromEnvironment(env);
  if (!options) return false;
  setGlobalDispatcher(new EnvHttpProxyAgent(options));
  configuredProxy = options;
  return true;
}

function value(input: string | undefined): string | undefined {
  const normalized = input?.trim();
  return normalized || undefined;
}
