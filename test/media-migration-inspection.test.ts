import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectMediaMigrations } from "../scripts/inspect-media-migrations.js";
import * as model3D from "../scripts/rehearse-model3d-migration.js";
import { snapshot } from "../src/daemon/minimax-settings-snapshot.js";
import {
  inspectMinimaxMigration,
  proposeMinimaxSettings,
} from "../src/daemon/minimax-migration-settings.js";
import {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  commitSettingsTransaction,
  SETTINGS_TRANSACTION_BACKUP,
} from "../src/daemon/minimax-settings-transaction.js";

const secret = "secret-must-never-appear-in-a-migration-report";
const directories: string[] = [];
async function fixture(files: Record<string, unknown> = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-migration-report-"),
  );
  directories.push(directory);
  for (const [file, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), JSON.stringify(value));
  }
  return directory;
}
async function bytes(directory: string): Promise<Record<string, string>> {
  const names = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Object.fromEntries(
    await Promise.all(
      names
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [
            path.relative(directory, file),
            (await readFile(file)).toString("base64"),
          ];
        }),
    ),
  );
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("combined media migration preflight", () => {
  it("rehearses all six providers offline without modifying supplied settings or projects", async () => {
    const directory = await fixture({
      "minimax.json": { version: 1, cnApiKey: secret },
      "unrelated.json": { keep: secret },
    });
    const workspace = await fixture();
    const before = await bytes(directory);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request"));
    const report = await inspectMediaMigrations(directory, [workspace]);
    expect(report).toMatchObject({
      status: "passed",
      activation: "held",
      sourceUnchanged: true,
      blockers: [],
      workspaces: { scope: "minimax-only", requested: 1, status: "inspected" },
    });
    expect(
      report.providers.map(({ provider, status }) => [provider, status]),
    ).toEqual(
      ["minimax", "seedance", "elevenlabs", "doubao", "meshy", "tripo"].map(
        (provider) => [provider, "passed"],
      ),
    );
    for (const result of report.providers)
      expect(result.rehearsal?.checks).toEqual({
        reload: true,
        idempotent: true,
        rollback: true,
        sourceUnchanged: true,
        cleanup: true,
      });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
    expect(await bytes(directory)).toEqual(before);
    expect(await bytes(workspace)).toEqual({});
  });

  it("reports an unreadable provider while completing independent rehearsals", async () => {
    const directory = await fixture({
      "elevenlabs.json": { version: 99, apiKey: secret },
    });
    const before = await bytes(directory);
    const report = await inspectMediaMigrations(directory);
    expect(report.status).toBe("blocked");
    expect(report.blockers).toContain("elevenlabs:legacy-settings-unreadable");
    expect(
      report.providers.find(({ provider }) => provider === "meshy")?.status,
    ).toBe("passed");
    expect(report.workspaces.status).toBe("not-requested");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await bytes(directory)).toEqual(before);
  });

  it.each(["minimax", "hyper3d"])(
    "refuses shared settings with an interrupted %s transaction without recovering it",
    async (provider) => {
      const directory = await fixture({
        [`.${provider}-settings-transaction.json`]: { unknown: secret },
      });
      const before = await bytes(directory);
      const report = await inspectMediaMigrations(directory);
      expect(report.blockers).toContain(
        `${provider}:interrupted-settings-transaction`,
      );
      expect(report.providers.every(({ status }) => status === "not-run")).toBe(
        true,
      );
      expect(await bytes(directory)).toEqual(before);
    },
  );

  it("recognizes a validated commit without copying the old key over a later user choice", async () => {
    const directory = await fixture({
      "minimax.json": { version: 1, cnApiKey: secret },
    });
    const original = await snapshot(directory);
    const { changes } = proposeMinimaxSettings(
      original,
      await inspectMinimaxMigration(directory),
    );
    await prepareSettingsTransaction(directory, original, changes);
    await resumeSettingsTransaction(directory);
    await commitSettingsTransaction(directory);
    // Removing the installed plugin or resetting its settings does not undo ownership.
    await rm(path.join(directory, "plugin-store/configuration.json"));
    const before = await bytes(directory);
    const report = await inspectMediaMigrations(directory);
    expect(
      report.providers.find(({ provider }) => provider === "minimax"),
    ).toEqual({ provider: "minimax", status: "committed", blockers: [] });
    expect(report.status).toBe("passed");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await bytes(directory)).toEqual(before);
  });

  it("does not mistake a malformed committed backup for a finished migration", async () => {
    const directory = await fixture({
      [SETTINGS_TRANSACTION_BACKUP]: { phase: "applied", secret },
    });
    const before = await bytes(directory);
    const report = await inspectMediaMigrations(directory);
    expect(report.blockers).toContain("minimax:committed-record-unreadable");
    expect(report.providers.every(({ status }) => status === "not-run")).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await bytes(directory)).toEqual(before);
  });

  it("reports a missing prepared package without hiding another provider's result or leaking errors", async () => {
    const original = model3D.rehearseModel3DMigration;
    vi.spyOn(model3D, "rehearseModel3DMigration").mockImplementation(
      (directory, provider) => {
        if (provider === "meshy") throw new Error(secret);
        return original(directory, provider);
      },
    );
    const report = await inspectMediaMigrations(await fixture());
    expect(report.blockers).toContain("meshy:rehearsal-unavailable");
    expect(
      report.providers.find(({ provider }) => provider === "tripo")?.status,
    ).toBe("passed");
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("invalidates the combined report when shared settings change during inspection", async () => {
    const directory = await fixture();
    const original = model3D.rehearseModel3DMigration;
    vi.spyOn(model3D, "rehearseModel3DMigration").mockImplementationOnce(
      async (source, provider) => {
        await writeFile(
          path.join(source, "minimax.json"),
          JSON.stringify({ version: 1, cnApiKey: secret }),
        );
        return original(source, provider);
      },
    );
    const report = await inspectMediaMigrations(directory);
    expect(report).toMatchObject({ status: "blocked", sourceUnchanged: false });
    expect(report.blockers).toContain("source-settings-changed");
  });

  it("rejects linked settings instead of reading another profile", async () => {
    const directory = await fixture(),
      outside = await fixture({ "configuration.json": { secret } });
    await symlink(
      outside,
      path.join(directory, "plugin-store"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(inspectMediaMigrations(directory)).rejects.toThrow(
      "Linked settings directory",
    );
    expect(await bytes(outside)).toEqual({
      "configuration.json": Buffer.from(JSON.stringify({ secret })).toString(
        "base64",
      ),
    });
  });

  it("exercises Node CLI success, blockers, missing data and the absence of an apply option", async () => {
    const directory = await fixture();
    const run = (args: string[]) =>
      promisify(execFile)("node", [
        "--conditions=ohmygame-source",
        "--import",
        "tsx",
        "scripts/inspect-media-migrations.ts",
        ...args,
      ]);
    const { stdout, stderr } = await run(["--data-dir", directory]);
    expect(JSON.parse(stdout).status).toBe("passed");
    expect(stderr).toBe("");
    await writeFile(path.join(directory, "elevenlabs.json"), secret);
    await expect(run(["--data-dir", directory])).rejects.toMatchObject({
      code: 1,
      stdout: expect.not.stringContaining(secret),
      stderr: "",
    });
    for (const args of [
      ["--data-dir", path.join(directory, secret)],
      ["--data-dir", directory, "--apply", secret],
    ])
      await expect(run(args)).rejects.toMatchObject({
        code: 2,
        stdout: "",
        stderr: expect.not.stringContaining(secret),
      });
  }, 30000);
});
