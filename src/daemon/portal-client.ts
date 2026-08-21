const REQUEST_TIMEOUT_MS = 10_000;

export interface PortalCredential {
  baseUrl: string;
  apiKey: string;
}

export class PortalClient {
  readonly origin: string;

  constructor(
    portalUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.origin = normalizeOrigin(portalUrl);
  }

  async credential(accessToken: string, signal?: AbortSignal): Promise<PortalCredential> {
    const response = await this.request("/api/opengame/credential", accessToken, signal, { method: "POST" });
    const body = await json(response);
    const data = record(body.data);
    const baseUrl = string(data.base_url);
    const apiKey = string(data.api_key);
    if (!baseUrl || !apiKey) throw new Error("Portal returned an invalid credential");
    return { baseUrl: normalizeApiUrl(baseUrl), apiKey };
  }

  async modelIds(credential: PortalCredential, signal?: AbortSignal): Promise<string[]> {
    const response = await this.request(`${credential.baseUrl}/models`, credential.apiKey, signal);
    const body = await json(response);
    if (!Array.isArray(body.data)) throw new Error("Portal returned an invalid model list");
    return [...new Set(body.data.map((item) => string(record(item).id)).filter((id): id is string => Boolean(id)))];
  }

  private async request(pathOrUrl: string, token: string, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this.fetch(new URL(pathOrUrl, this.origin), {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Portal request failed (${response.status})`);
    return response;
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Portal URL must use HTTPS");
  }
  return url.origin;
}

function normalizeApiUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Portal API URL must use HTTPS");
  }
  return url.href.replace(/\/$/, "");
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return record(await response.json());
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
