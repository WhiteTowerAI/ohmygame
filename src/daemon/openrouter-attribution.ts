import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// OpenRouter app attribution: https://openrouter.ai/docs/app-attribution
// The referer is the app's permanent identity in OpenRouter rankings; do not change it.
export const OPENROUTER_ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  "HTTP-Referer": "https://ohmygame.ai/",
  "X-OpenRouter-Title": "OhMyGame",
  "X-OpenRouter-Categories": "game,native-app-builder",
};

// Pi attributes OpenRouter traffic to itself unless told otherwise.
const PI_DEFAULT_ATTRIBUTION: Readonly<Record<string, string>> = {
  "http-referer": "https://pi.dev",
  "x-openrouter-title": "pi",
  "x-openrouter-categories": "cli-agent",
};

const OPENROUTER_HOST = "openrouter.ai";

export function isOpenRouterModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  if (!model) return false;
  if (model.provider === "openrouter") return true;
  try {
    return new URL(model.baseUrl ?? "").hostname === OPENROUTER_HOST;
  } catch {
    return false;
  }
}

/** Adds OhMyGame attribution; headers the user configured keep precedence. */
export function withOpenRouterAttribution(headers: Record<string, string>): Record<string, string> {
  const result = { ...headers };
  applyAttribution(result);
  return result;
}

/** Pi extension that attributes agent-session OpenRouter traffic to OhMyGame. */
export const openRouterAttributionExtension: ExtensionFactory = (pi) => {
  pi.on("before_provider_headers", (event, ctx) => {
    if (isOpenRouterModel(ctx.model)) applyAttribution(event.headers);
  });
};

function applyAttribution(headers: Record<string, string | null>): void {
  for (const [name, value] of Object.entries(OPENROUTER_ATTRIBUTION_HEADERS)) {
    const key = name.toLowerCase();
    const existing = Object.keys(headers).filter((candidate) => candidate.toLowerCase() === key);
    const userConfigured = existing.some((candidate) => {
      const current = headers[candidate];
      return typeof current === "string" && current !== PI_DEFAULT_ATTRIBUTION[key];
    });
    if (userConfigured) continue;
    for (const candidate of existing) delete headers[candidate];
    headers[name] = value;
  }
}
