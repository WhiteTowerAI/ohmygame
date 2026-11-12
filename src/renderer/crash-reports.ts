import { init as initSentry } from "@sentry/electron/renderer";
import { onUsageDataChange, readUsageDataEnabled } from "./analytics.js";

let initialized = false;

/**
 * Sends the Usage data choice to the desktop main process, which gates crash
 * reports behind the same switch, and starts the renderer SDK when it is on.
 * Called at startup and whenever the choice changes.
 */
export function updateCrashReporting(): void {
  const enabled = readUsageDataEnabled();
  void window.ohMyGameDesktop?.setCrashReports?.(enabled).catch(() => undefined);
  if (enabled && !initialized) {
    initialized = true;
    initSentry();
  }
}

onUsageDataChange(() => updateCrashReporting());
