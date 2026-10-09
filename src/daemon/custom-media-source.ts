import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CustomProviderSettings } from "../shared/contracts.js";
import type { ImageSource } from "./image-adapters.js";

export async function customMediaSource(runtime: ModelRuntime, provider: CustomProviderSettings, baseUrl?: string, signal?: AbortSignal): Promise<ImageSource> {
  const auth = await runtime.getAuth(provider.id, { signal });
  const apiKey = auth?.auth.apiKey;
  if (provider.authentication !== "none" && !apiKey) throw new Error(`${provider.name} API key is not configured`);
  return { baseUrl: baseUrl ?? provider.baseUrl, apiKey: apiKey ?? "ohmygame-local", authentication: provider.authentication,
    headers: Object.fromEntries(Object.entries(auth?.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
}
