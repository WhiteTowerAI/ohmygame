import {
  diagnosticSection,
  diagnosticsArchive,
} from "../daemon/diagnostics.js";
import type { DesktopRuntimeState } from "../shared/desktop-runtime.js";

export interface DesktopDiagnosticsOptions {
  logDirectory: string;
  logs: readonly { idle(): Promise<void> }[];
  service: () => DesktopRuntimeState | undefined;
  redact: (text: string) => string;
  now?: () => Date;
}

/**
 * The diagnostics ZIP built by the desktop app itself, for when the
 * background service, which normally builds it, is not running.
 */
export async function desktopDiagnosticsArchive(
  options: DesktopDiagnosticsOptions,
): Promise<Buffer> {
  // Include the lines still being written.
  await Promise.all(options.logs.map((log) => log.idle()));
  return diagnosticsArchive({
    logDirectory: options.logDirectory,
    now: options.now,
    redact: options.redact,
    summary: async () => ({
      exportedBy: "desktop",
      service: await diagnosticSection(() => {
        const state = options.service();
        if (!state) return { status: "not started" };
        // The runtime holds the service's address and access token; they stay out.
        return {
          status: state.status,
          generation: state.generation,
          recovered: state.recovered,
          ...(state.error ? { error: state.error } : {}),
        };
      }),
    }),
  });
}
