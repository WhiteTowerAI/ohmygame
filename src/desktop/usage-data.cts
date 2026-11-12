import path from "node:path";
import { app } from "electron";
import { getClient, init, makeElectronTransport } from "@sentry/electron/main";
import { UsageDataPreference } from "./usage-data-preference.js";

let preference: UsageDataPreference;
let crashClient: ReturnType<typeof getClient>;

export function initializeCrashReporting(dsn: string | undefined): void {
  preference = new UsageDataPreference(
    path.join(app.getPath("userData"), "usage-data.json"),
  );
  if (!dsn) {
    init({ enabled: false, sendDefaultPii: false });
    return;
  }

  init({
    dsn,
    sendDefaultPii: false,
    integrations: (defaults) => [
      {
        name: "OhMyGameUsageData",
        // Let Sentry set up its crash handlers even when uploads are disabled.
        // Its minidump loader drops pending dumps when the client is disabled.
        beforeSetup: (client) => {
          client.getOptions().enabled = preference.enabled;
        },
      },
      ...defaults,
    ],
    transport: (options) => {
      // Use the live transport so a queued envelope cannot outlive an opt-out.
      const transport = makeElectronTransport(options);
      return {
        send: async (envelope) => {
          await app.whenReady();
          return preference.enabled ? transport.send(envelope) : {};
        },
        flush: (timeout) => transport.flush(timeout),
      };
    },
  });
  crashClient = getClient();
}

export function readUsageData(): boolean {
  return preference.enabled;
}

export function updateUsageData(
  enabled: boolean,
  initialize: boolean,
): boolean {
  if (initialize) preference.initialize(enabled);
  else preference.set(enabled);
  if (crashClient) crashClient.getOptions().enabled = preference.enabled;
  return preference.enabled;
}
