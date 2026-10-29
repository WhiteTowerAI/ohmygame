import type { PostHog } from "posthog-js/dist/module.no-external.js";
import { AnalyticsUrlScrubber } from "./analytics-url.js";

const USAGE_DATA_STORAGE_KEY = "ohmygame:usage-data";
let configured = false;
let enabled = readUsageDataEnabled();
let client: PostHog | undefined;
let loading: Promise<void> | undefined;
// Undefined until sign-in state is known; null while signed out.
let accountId: string | null | undefined;

export function initializeAnalytics(): void {
  configured = true;
  if (enabled) void loadClient();
}

export function readUsageDataEnabled(): boolean {
  try {
    return localStorage.getItem(USAGE_DATA_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setUsageDataEnabled(value: boolean): void {
  enabled = value;
  try {
    localStorage.setItem(USAGE_DATA_STORAGE_KEY, value ? "on" : "off");
  } catch { /* The choice still applies until the app restarts. */ }
  if (!value) client?.opt_out_capturing();
  else if (configured) void loadClient().then(synchronize);
}

/** Links usage data to the signed-in OhMyGame account, by account id only. */
export function setAnalyticsAccount(id: string | null): void {
  accountId = id;
  synchronize();
}

function loadClient(): Promise<void> {
  if (client) return Promise.resolve();
  if (loading) return loading;
  const key = import.meta.env.VITE_POSTHOG_KEY?.trim();
  const host = import.meta.env.VITE_POSTHOG_HOST?.trim();
  if (!enabled || !key || !host) return Promise.resolve();
  const scrubber = new AnalyticsUrlScrubber(window.location.pathname);
  // Keep PostHog out of the startup bundle and never load remote scripts.
  loading = import("posthog-js/dist/module.no-external.js").then(({ posthog }) => {
    // The person may have turned usage data off while the import was pending.
    if (!enabled) return;
    posthog.init(key, {
      api_host: host,
      autocapture: true,
      capture_pageview: { hash: true },
      capture_pageleave: true,
      disable_session_recording: true,
      person_profiles: "identified_only",
      capture_exceptions: false,
      before_send: (event) => {
        if (!event || !enabled) return null;
        scrubber.scrub(event, window.location.href);
        event.properties.app_version = __APP_VERSION__;
        return event;
      },
    });
    client = posthog;
    synchronize();
  }).finally(() => { loading = undefined; });
  return loading;
}

function synchronize(): void {
  if (!enabled || !client) return;
  if (client.has_opted_out_capturing()) client.opt_in_capturing({ captureEventName: false });
  if (accountId) {
    if (client.get_distinct_id() !== accountId) client.identify(accountId);
  } else if (accountId === null && client.get_property("$user_state") === "identified") {
    // A new anonymous id keeps the next person's use apart from this account.
    client.reset();
  }
}
