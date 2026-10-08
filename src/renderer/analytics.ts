import { posthog } from "posthog-js";
import { AnalyticsUrlScrubber } from "./analytics-url.js";

export function initializeAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY?.trim();
  const host = import.meta.env.VITE_POSTHOG_HOST?.trim();
  if (!key || !host) return;

  const scrubber = new AnalyticsUrlScrubber(window.location.pathname);
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
}
