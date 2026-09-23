import { app } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { init as initSentry } from "@sentry/electron/main";

const sentryDsn = readSentryDsn();
initSentry({
  dsn: sentryDsn,
  enabled: Boolean(sentryDsn),
  sendDefaultPii: false,
});

void import("./main.js").catch((error) => {
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
