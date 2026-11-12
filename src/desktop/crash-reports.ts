import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The Usage data choice the renderer last sent; a start applies it before the renderer has spoken. */
let enabled = true;

/**
 * Installs crash reporting, with every envelope held back once the Usage data switch is off.
 *
 * Sentry is imported here instead of at the top: main.ts imports this module
 * for the setter, and a static import would pull the SDK's whole module graph
 * into every desktop importer and test.
 */
export async function initCrashReporting(dsn: string | undefined): Promise<void> {
  enabled = readStoredChoice();
  const { init: initSentry, makeElectronOfflineTransport } = await import("@sentry/electron/main");
  initSentry({
    dsn,
    enabled: Boolean(dsn),
    sendDefaultPii: false,
    // The gate sits on the transport because it is the only place every
    // envelope passes through: sessions and minidumps skip a `beforeSend` gate.
    transport: (options) => {
      const transport = makeElectronOfflineTransport()(options);
      return {
        // A dropped envelope answers as delivered, so the offline store does not keep it for a later start.
        send: (request) => (enabled ? transport.send(request) : Promise.resolve({})),
        flush: (timeout) => transport.flush(timeout),
      };
    },
  });
}

/** Applies the renderer's Usage data choice and keeps it for the next start. */
export function setCrashReportingEnabled(value: boolean): void {
  enabled = value;
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(
      path.join(app.getPath("userData"), "crash-reports.json"),
      `${JSON.stringify({ enabled: value })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("Could not store the crash report choice; it applies until the app restarts.", error);
  }
}

function readStoredChoice(): boolean {
  try {
    const stored = JSON.parse(readFileSync(path.join(app.getPath("userData"), "crash-reports.json"), "utf8")) as {
      enabled?: unknown;
    };
    return stored.enabled !== false;
  } catch {
    // The file is missing on first run, and nothing has been stored yet.
    return true;
  }
}
