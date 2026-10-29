import type { PostHog } from "posthog-js/dist/module.no-external.js";
import { AnalyticsUrlScrubber } from "./analytics-url.js";

const USAGE_DATA_STORAGE_KEY = "ohmygame:usage-data";

let configured = false;
let client: Promise<PostHog> | undefined;
// Undefined until sign-in state is known; null while signed out.
let accountId: string | null | undefined;

export function initializeAnalytics(): void {
  configured = true;
  if (readUsageDataEnabled()) void loadClient();
}

export function readUsageDataEnabled(): boolean {
  try {
    return localStorage.getItem(USAGE_DATA_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setUsageDataEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(USAGE_DATA_STORAGE_KEY, enabled ? "on" : "off");
  } catch { /* The choice still applies until the app restarts. */ }
  if (enabled) {
    if (configured) void loadClient()?.then(optIn);
  } else {
    void client?.then((posthog) => posthog.opt_out_capturing());
  }
}

/** Links usage data to the signed-in OhMyGame account, by account id only. */
export function setAnalyticsAccount(id: string | null): void {
  accountId = id;
  void client?.then(applyAccount);
}

function loadClient(): Promise<PostHog> | undefined {
  const key = import.meta.env.VITE_POSTHOG_KEY?.trim();
  const host = import.meta.env.VITE_POSTHOG_HOST?.trim();
  if (!key || !host) return undefined;
  if (client) return client;

  const scrubber = new AnalyticsUrlScrubber(window.location.pathname);
  // posthog-js is large; keep it out of the startup bundle. The CSP allows no
  // remote scripts, so use the build that loads none and bundle exception
  // capture, which PostHog would otherwise fetch as a script. Remote config
  // still arrives as JSON, and autocapture waits for it.
  client = import("posthog-js/dist/exception-autocapture.js")
    .then(() => import("posthog-js/dist/module.no-external.js"))
    .then(({ posthog }) => {
      posthog.init(key, {
        api_host: host,
        autocapture: true,
        // Routes live in the hash; the pathname is the install path and never changes.
        capture_pageview: { hash: true },
        capture_pageleave: true,
        disable_session_recording: true,
        person_profiles: "identified_only",
        before_send: (event) => {
          if (!event) return event;
          scrubber.scrub(event, window.location.href);
          event.properties.app_version = __APP_VERSION__;
          return event;
        },
      });
      // Turning usage data off opts PostHog out, and it remembers that.
      optIn(posthog);
      applyAccount(posthog);
      return posthog;
    });
  return client;
}

function optIn(posthog: PostHog): void {
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
}

function applyAccount(posthog: PostHog): void {
  if (accountId) {
    if (posthog.get_distinct_id() !== accountId) posthog.identify(accountId);
  } else if (accountId === null && posthog.get_property("$user_state") === "identified") {
    // A new anonymous id keeps the next person's use apart from this account.
    posthog.reset();
  }
}
