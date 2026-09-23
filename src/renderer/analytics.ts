import { posthog } from "posthog-js";

export function initializeAnalytics(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY?.trim();
  const host = import.meta.env.VITE_POSTHOG_HOST?.trim();
  if (!key || !host) return;

  posthog.init(key, {
    api_host: host,
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
    person_profiles: "identified_only",
  });
}
