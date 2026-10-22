import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { ZipFile } from "yazl";
import { diagnosticsFileName } from "../shared/diagnostics.js";
import { createLogRedactor } from "../shared/log-redaction.js";

const APP_VERSION: string = createRequire(import.meta.url)(
  "../../package.json",
).version;
/** The files the desktop app writes; anything else in the folder stays out. */
const LOG_FILE = /^(?:main|daemon)(?:\.\d+)?\.log$/;

/** A section that could not be read says why instead of failing the export. */
export type DiagnosticsSection<T> = T | { error: string };

/** What is connected and enabled, by name only: never keys, accounts or paths. */
export interface DiagnosticsSummary {
  providers: DiagnosticsSection<
    {
      id: string;
      enabled: boolean;
      custom: boolean;
      capabilities: readonly string[];
    }[]
  >;
  agents: DiagnosticsSection<
    {
      id: string;
      enabled: boolean;
      installed: boolean;
      version?: string;
      auth: string;
    }[]
  >;
  plugins: DiagnosticsSection<
    { id: string; version?: string; enabled: boolean; beta?: boolean }[]
  >;
  projects: DiagnosticsSection<Record<string, number>>;
}

/**
 * People export diagnostics when something is broken, so a part that fails
 * to load is recorded in place and the logs are still exported.
 */
export async function diagnosticSection<T>(
  load: () => T | Promise<T>,
): Promise<DiagnosticsSection<T>> {
  try {
    return await load();
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export interface DiagnosticsOptions<
  Summary extends object = DiagnosticsSummary,
> {
  /** Where the desktop app writes its logs. A daemon started on its own has none. */
  logDirectory?: string;
  /** The daemon describes providers, agents and plugins; the desktop app, when the service is down, its status. */
  summary: () => Promise<Summary>;
  redact?: (text: string) => string;
  now?: () => Date;
}

/**
 * A ZIP for bug reports: the desktop logs, which are redacted as they are
 * written, and `system.json`. It holds no settings, conversations or project files.
 */
export async function diagnosticsArchive<Summary extends object>(
  options: DiagnosticsOptions<Summary>,
): Promise<Buffer> {
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const redact = options.redact ?? createLogRedactor();
  const logs = await diagnosticSection(() => logFiles(options.logDirectory));
  const summary = await diagnosticSection(options.summary);
  const zip = new ZipFile();
  if (Array.isArray(logs)) {
    for (const log of logs) zip.addBuffer(log.content, `logs/${log.name}`);
  }
  const system = {
    format: 1,
    createdAt,
    app: { version: APP_VERSION },
    system: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron
        ? { electron: process.versions.electron }
        : {}),
      ...(process.versions.chrome ? { chrome: process.versions.chrome } : {}),
      uptimeSeconds: Math.round(process.uptime()),
    },
    logs: !options.logDirectory
      ? "not recorded"
      : Array.isArray(logs)
        ? logs.map((log) => log.name)
        : logs,
    ...("error" in summary ? { summaryError: summary.error } : summary),
  };
  zip.addBuffer(
    Buffer.from(
      `${JSON.stringify(system, (_key, value) => (typeof value === "string" ? redact(value) : value), 2)}\n`,
    ),
    "system.json",
  );
  return zipBuffer(zip);
}

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  options: DiagnosticsOptions,
): void {
  app.post("/diagnostics/export", async (_request, reply) => {
    const now = options.now?.() ?? new Date();
    const archive = await diagnosticsArchive({ ...options, now: () => now });
    return reply
      .type("application/zip")
      .header(
        "content-disposition",
        `attachment; filename="${diagnosticsFileName(now)}"`,
      )
      .send(archive);
  });
}

async function logFiles(
  directory: string | undefined,
): Promise<{ name: string; content: Buffer }[]> {
  if (!directory) return [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const logs = await Promise.all(
    names
      .filter((name) => LOG_FILE.test(name))
      .sort()
      .map(async (name) => {
        try {
          // Read now: the desktop app keeps appending, and a ZIP entry needs a fixed size.
          return { name, content: await readFile(path.join(directory, name)) };
        } catch (error) {
          // Rotation can move a file between listing and reading.
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      }),
  );
  return logs.filter((log) => log !== undefined);
}

function zipBuffer(zip: ZipFile): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const output = zip.outputStream as Readable;
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    output.once("error", reject);
    zip.on("error", reject);
    output.once("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return completed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
