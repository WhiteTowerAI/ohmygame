import { app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

// Crash reporting gates every Sentry envelope on the Usage data choice, so it
// must be installed before main runs and before anything can be sent.
void import("./crash-reports.js")
  .then(({ initCrashReporting }) => initCrashReporting(readSentryDsn()))
  .then(() => import("./main.js"))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

function readSentryDsn(): string | undefined {
  const configured = process.env.SENTRY_DSN?.trim();
  if (configured) return configured;
  if (!app.isPackaged) return undefined;

  try {
    const config = JSON.parse(readFileSync(path.join(process.resourcesPath, "desktop-config.json"), "utf8")) as {
      sentryDsn?: unknown;
    };
    return typeof config.sentryDsn === "string" && config.sentryDsn ? config.sentryDsn : undefined;
  } catch (error) {
    console.warn("Could not read Sentry configuration; error monitoring is disabled.", error);
    return undefined;
  }
}
