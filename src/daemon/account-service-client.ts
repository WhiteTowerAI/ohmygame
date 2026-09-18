import { readFile } from "node:fs/promises";
import type { AccountPlan, AccountSubscription, AccountUsage } from "../shared/account.js";
import type { StagedVideoReference, VideoReferenceAsset } from "./seedance-video.js";

const REQUEST_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export interface AccountCredential {
  baseUrl: string;
  apiKey: string;
}

export class AccountServiceClient {
  readonly origin: string;

  constructor(
    accountServiceUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.origin = normalizeOrigin(accountServiceUrl);
  }

  async credential(accessToken: string, signal?: AbortSignal): Promise<AccountCredential> {
    const response = await this.request("/api/credential", accessToken, signal, { method: "POST" });
    const body = await json(response);
    const data = record(body.data);
    const baseUrl = string(data.base_url);
    const apiKey = string(data.api_key);
    if (!baseUrl || !apiKey) throw new Error("Account service returned an invalid credential");
    return { baseUrl: normalizeApiUrl(baseUrl), apiKey };
  }

  plans(): Promise<AccountPlan[]> {
    return this.accountRequest("/api/plans");
  }

  subscription(accessToken: string): Promise<AccountSubscription> {
    return this.accountRequest("/api/subscription", accessToken);
  }

  usage(accessToken: string, page: number): Promise<AccountUsage> {
    return this.accountRequest(`/api/usage?page=${page}`, accessToken);
  }

  checkout(accessToken: string, planId: number): Promise<{ url: string }> {
    return this.accountRequest("/api/subscription/checkout", accessToken, {
      method: "POST",
      body: JSON.stringify({ plan_id: planId }),
      headers: { "content-type": "application/json" },
    });
  }

  manageSubscription(accessToken: string): Promise<{ url: string }> {
    return this.accountRequest("/api/subscription/manage", accessToken, { method: "POST" });
  }

  private async accountRequest<T>(path: string, accessToken?: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, accessToken, undefined, init);
    const body = await json(response);
    if (body.data === undefined) throw new Error("Invalid account response");
    return body.data as T;
  }

  async modelIds(credential: AccountCredential, signal?: AbortSignal): Promise<string[]> {
    const response = await this.request(`${credential.baseUrl}/models`, credential.apiKey, signal);
    const body = await json(response);
    if (!Array.isArray(body.data)) throw new Error("Account service returned an invalid model list");
    return [...new Set(body.data.map((item) => string(record(item).id)).filter((id): id is string => Boolean(id)))];
  }

  async stageMedia(accessToken: string, reference: VideoReferenceAsset, signal?: AbortSignal): Promise<StagedVideoReference> {
    const query = new URLSearchParams({ media_type: reference.mediaType });
    const response = await this.request(`/api/media?${query}`, accessToken, signal, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: await readFile(reference.absolutePath),
    }, UPLOAD_TIMEOUT_MS);
    const data = record((await json(response)).data);
    const id = string(data.id);
    const url = string(data.url);
    if (!id || !url) throw new Error("Account service returned an invalid media reference");
    return { id, url };
  }

  async removeMedia(accessToken: string, id: string): Promise<void> {
    await this.request(`/api/media/${encodeURIComponent(id)}`, accessToken, undefined, { method: "DELETE" });
  }

  private async request(pathOrUrl: string, token: string | undefined, signal?: AbortSignal, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetch(new URL(pathOrUrl, this.origin), {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Account service request failed (${response.status})`);
    return response;
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Account service URL must use HTTPS");
  }
  return url.origin;
}

function normalizeApiUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Account API URL must use HTTPS");
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
