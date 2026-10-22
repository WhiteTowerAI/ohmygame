import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import { desktopDiagnosticsArchive } from "../src/desktop/diagnostics-export.js";
import { createLogRedactor } from "../src/shared/log-redaction.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

function entries(archive: Buffer): Promise<Record<string, string>> {
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
      zip.once("end", () => resolve(files));
      zip.readEntry();
    });
  });
}

it("exports the logs and the service status without the service", async () => {
  const logDirectory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-desktop-diagnostics-"),
  );
  directories.push(logDirectory);
  const idle = vi.fn(async () => {
    await writeFile(
      path.join(logDirectory, "daemon.log"),
      "OhMyGame service exited (1)\n",
    );
  });

  const files = await entries(
    await desktopDiagnosticsArchive({
      logDirectory,
      logs: [{ idle }],
      service: () => ({
        status: "error",
        generation: 3,
        recovered: false,
        runtime: { url: "http://127.0.0.1:50000", token: "secret-token" },
        error:
          "The background service exited (1)\n\nDaemon output:\nCannot open /Users/someone/data",
      }),
      redact: createLogRedactor("/Users/someone", "darwin"),
    }),
  );

  expect(idle).toHaveBeenCalledOnce();
  expect(files["logs/daemon.log"]).toBe("OhMyGame service exited (1)\n");
  const system = JSON.parse(files["system.json"]!);
  expect(system).toMatchObject({
    exportedBy: "desktop",
    service: { status: "error", generation: 3, recovered: false },
  });
  expect(system.service.error).toContain("Cannot open ~/data");
  expect(files["system.json"]).not.toContain("secret-token");
  expect(files["system.json"]).not.toContain("127.0.0.1:50000");
});

it("says when the service never started", async () => {
  const files = await entries(
    await desktopDiagnosticsArchive({
      logDirectory: path.join(tmpdir(), "ohmygame-missing-logs"),
      logs: [],
      service: () => undefined,
      redact: (text) => text,
    }),
  );

  expect(JSON.parse(files["system.json"]!).service).toEqual({
    status: "not started",
  });
});
