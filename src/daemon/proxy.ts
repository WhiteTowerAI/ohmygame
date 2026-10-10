import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export interface ProxyOptions {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

function normalizeProxyUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  return `http://${input}`;
}

function isValidProxyUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (!url.hostname) return false;
  if (url.hostname.startsWith("[") && !url.hostname.endsWith("]")) return false;
  return true;
}

export function proxyOptionsFromEnvironment(env: NodeJS.ProcessEnv): ProxyOptions | undefined {
  const httpProxy = value(env.HTTP_PROXY) ?? value(env.http_proxy) ?? value(env.HTTPS_PROXY) ?? value(env.https_proxy);
  const httpsProxy = value(env.HTTPS_PROXY) ?? value(env.https_proxy) ?? httpProxy;
  if (!httpProxy || !httpsProxy) return undefined;

  const normalizedHttp = normalizeProxyUrl(httpProxy);
  const normalizedHttps = normalizeProxyUrl(httpsProxy);
  if (!isValidProxyUrl(normalizedHttp) || !isValidProxyUrl(normalizedHttps)) return undefined;

  const exclusions = new Set(
    (value(env.NO_PROXY) ?? value(env.no_proxy) ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  exclusions.add("127.0.0.1");
  exclusions.add("localhost");
  exclusions.add(".localhost");

  return {
    httpProxy: normalizedHttp,
    httpsProxy: normalizedHttps,
    noProxy: [...exclusions].join(","),
  };
}

export function configureNetworkProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  const options = proxyOptionsFromEnvironment(env);
  if (!options) return false;
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent(options));
  } catch {
    return false;
  }
  return true;
}

function value(input: string | undefined): string | undefined {
  const normalized = input?.trim();
  return normalized || undefined;
}
