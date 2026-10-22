import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createLogRedactor } from "../src/shared/log-redaction.js";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { createApp } from "../src/daemon/app.js";
import {
  diagnosticSection,
  diagnosticsArchive,
  type DiagnosticsSummary,
} from "../src/daemon/diagnostics.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
const summary: DiagnosticsSummary = {
  providers: [
    { id: "openai", enabled: true, custom: false, capabilities: ["language"] },
  ],
  agents: [
    {
      id: "codex",
      enabled: true,
      installed: true,
      version: "0.50.0",
      auth: "signed-in",
    },
  ],
  plugins: [{ id: "godot", version: "0.1.0", enabled: true, beta: true }],
  projects: { "web-game": 2 },
};

async function directory(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(created);
  return created;
}

function unzip(archive: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files: Record<string, string> = {};
      zip.on("entry", (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("end", () => {
            files[entry.fileName] = Buffer.concat(chunks).toString("utf8");
            zip.readEntry();
          });
        });
      });
      zip.once("error", reject);
      zip.once("end", () => resolve(files));
      zip.readEntry();
    });
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("diagnostics export", () => {
  it("includes the desktop logs and system information, and nothing else from the folder", async () => {
    const logs = await directory("ohmygame-diagnostics-logs-");
    await writeFile(path.join(logs, "main.log"), "main line\n");
    await writeFile(path.join(logs, "daemon.log"), "daemon line\n");
    await writeFile(path.join(logs, "daemon.1.log"), "older daemon line\n");
    await writeFile(path.join(logs, "notes.txt"), "unrelated\n");
    await mkdir(path.join(logs, "crashes"));

    const files = await unzip(
      await diagnosticsArchive({
        logDirectory: logs,
        summary: async () => summary,
        now: () => new Date("2026-10-21T08:00:00.000Z"),
      }),
    );

    expect(Object.keys(files).sort()).toEqual([
      "logs/daemon.1.log",
      "logs/daemon.log",
      "logs/main.log",
      "system.json",
    ]);
    expect(files["logs/daemon.log"]).toBe("daemon line\n");
    const system = JSON.parse(files["system.json"]!);
    expect(system).toMatchObject({
      format: 1,
      createdAt: "2026-10-21T08:00:00.000Z",
      app: { version: expect.any(String) },
      system: { platform: process.platform, arch: process.arch },
      runtime: { node: process.versions.node },
      logs: ["daemon.1.log", "daemon.log", "main.log"],
      ...summary,
    });
    expect(files["system.json"]).not.toContain(logs);
  });

  it("says when no logs are recorded", async () => {
    const files = await unzip(
      await diagnosticsArchive({ summary: async () => summary }),
    );

    expect(Object.keys(files)).toEqual(["system.json"]);
    expect(JSON.parse(files["system.json"]!).logs).toBe("not recorded");
  });

  it("still exports the logs when part of the summary or the logs folder fails", async () => {
    const logs = await directory("ohmygame-diagnostics-partial-");
    await writeFile(path.join(logs, "daemon.log"), "service starting\n");

    const partial = await unzip(
      await diagnosticsArchive({
        logDirectory: logs,
        summary: async () => ({
          ...summary,
          plugins: await diagnosticSection(() => {
            throw new Error("The plugin marketplace is unreadable");
          }),
        }),
      }),
    );
    expect(partial["logs/daemon.log"]).toBe("service starting\n");
    expect(JSON.parse(partial["system.json"]!).plugins).toEqual({
      error: "The plugin marketplace is unreadable",
    });

    const failedSummary = await unzip(
      await diagnosticsArchive({
        logDirectory: logs,
        summary: async () => {
          throw new Error("The service is shutting down");
        },
      }),
    );
    expect(failedSummary["logs/daemon.log"]).toBe("service starting\n");
    expect(JSON.parse(failedSummary["system.json"]!).summaryError).toBe(
      "The service is shutting down",
    );

    const notAFolder = path.join(logs, "daemon.log");
    const unreadableLogs = await unzip(
      await diagnosticsArchive({
        logDirectory: notAFolder,
        summary: async () => summary,
      }),
    );
    expect(Object.keys(unreadableLogs)).toEqual(["system.json"]);
    expect(JSON.parse(unreadableLogs["system.json"]!).logs).toEqual({
      error: expect.stringContaining("ENOTDIR"),
    });
  });

  it("exports configured providers by name only", async () => {
    const dataDirectory = await directory("ohmygame-diagnostics-data-");
    const logs = await directory("ohmygame-diagnostics-route-logs-");
    await writeFile(path.join(logs, "daemon.log"), "service starting\n");
    const app = createApp({ dataDirectory, logDirectory: logs });
    apps.push(app);
    await app.inject({
      method: "PUT",
      url: "/settings/models/providers/meshy",
      payload: { apiKey: "msy_secret_value" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/diagnostics/export",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/zip");
    expect(response.headers["content-disposition"]).toMatch(
      /^attachment; filename="ohmygame-diagnostics-\d{8}-\d{6}\.zip"$/,
    );
    const files = await unzip(response.rawPayload);
    expect(files["logs/daemon.log"]).toBe("service starting\n");
    const system = JSON.parse(files["system.json"]!);
    // Keys in the test environment can configure other providers too.
    expect(system.providers).toContainEqual({
      id: "meshy",
      enabled: true,
      custom: false,
      capabilities: ["3d"],
    });
    expect(files["system.json"]).not.toContain("msy_secret_value");
    expect(files["system.json"]).not.toContain(dataDirectory);
  });

  it("redacts failed sections, summary errors and filesystem errors without truncating the JSON", async () => {
    const logs = await directory("ohmygame-diagnostics-redaction-");
    const notAFolder = path.join(logs, "blocked");
    await writeFile(notAFolder, "not a folder");
    const redact = createLogRedactor(logs);
    const files = await unzip(
      await diagnosticsArchive({
        logDirectory: notAFolder,
        redact,
        summary: async () => ({
          ...summary,
          plugins: await diagnosticSection(() => {
            throw new Error(
              'api_key=fixture_key {"password":"fixture_password"}',
            );
          }),
          projects: Object.fromEntries(
            Array.from({ length: 2_000 }, (_, index) => [
              `type-${index}`,
              index,
            ]),
          ),
        }),
      }),
    );
    const system = JSON.parse(files["system.json"]!);
    expect(system.logs.error).toContain("ENOTDIR");
    expect(system.logs.error).toContain("~");
    expect(Object.keys(system.projects)).toHaveLength(2_000);
    expect(system.plugins.error).toContain("[redacted]");
    for (const secret of [logs, "fixture_key", "fixture_password"])
      expect(files["system.json"]).not.toContain(secret);

    const failed = await unzip(
      await diagnosticsArchive({
        summary: async () => {
          throw new Error(`Cannot load ${homedir()}/data? api_key=fixture_key`);
        },
      }),
    );
    expect(JSON.parse(failed["system.json"]!).summaryError).toContain("~/data");
    expect(failed["system.json"]).not.toContain(homedir());
    expect(failed["system.json"]).not.toContain("fixture_key");
  });
});
