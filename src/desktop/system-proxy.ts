const PROXY_TARGET = "https://api.openai.com";

export async function applySystemProxy(
  environment: NodeJS.ProcessEnv,
  resolveProxy: (url: string) => Promise<string>,
): Promise<void> {
  if (hasProxy(environment)) return;
  const proxyUrl = proxyUrlFromElectron(await resolveProxy(PROXY_TARGET));
  if (!proxyUrl) return;
  environment.HTTP_PROXY = proxyUrl;
  environment.HTTPS_PROXY = proxyUrl;
}

export function proxyUrlFromElectron(value: string): string | undefined {
  for (const entry of value.split(";")) {
    const [type, address] = entry.trim().split(/\s+/, 2);
    const proxyType = type?.toUpperCase();
    const protocol = proxyType === "PROXY" ? "http" : proxyType === "HTTPS" ? "https" : undefined;
    if (!protocol || !address) continue;
    try {
      const url = new URL(`${protocol}://${address}`);
      if (url.hostname) return url.toString().replace(/\/$/, "");
    } catch {
    }
  }
  return undefined;
}

function hasProxy(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(
    environment.HTTP_PROXY?.trim() || environment.http_proxy?.trim() ||
    environment.HTTPS_PROXY?.trim() || environment.https_proxy?.trim(),
  );
}
