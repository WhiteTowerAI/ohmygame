import { migrateSeedanceSettings } from "../src/daemon/seedance-settings-migration.js";
import { migrateMediaSettingsAtStartup } from "../src/daemon/media-settings-startup.js";
import { MINIMAX_MIGRATION_PACKAGES } from "../src/daemon/minimax-migration-package.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { capabilityGrants } from "../src/daemon/project-plugins.js";
import { SEEDANCE_MIGRATION_PACKAGES, seedanceMigrationPackageIssue } from "../src/daemon/seedance-migration-package.js";
import { SEEDANCE_MIGRATION_REGIONS } from "../src/daemon/seedance-migration-settings.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { killAt } from "./fixtures/settings-transaction-process.js";
import { rehearseSeedanceMigration } from "../scripts/rehearse-seedance-migration.js";
import { proposeSeedanceSettings } from "../src/daemon/seedance-migration-settings.js";
import { snapshot as settingsSnapshot, same } from "../src/daemon/seedance-settings-snapshot.js";
import { prepareSettingsTransaction, resumeSettingsTransaction, rollbackSettingsTransaction, forgetSettingsTransaction, recoverInterruptedSeedanceSettings, commitSettingsTransaction, hasCommittedSettingsTransaction, SETTINGS_TRANSACTION_FILE, SETTINGS_TRANSACTION_BACKUP } from "../src/daemon/seedance-settings-transaction.js";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectSeedanceMigration } from "../scripts/inspect-seedance-migration.js";
import { SeedanceSettingsStore } from "../src/daemon/seedance-settings.js";

describe("Seedance settings", () => {
  it("persists the domestic and international API keys independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-settings-"));
    const settings = new SeedanceSettingsStore(directory);
    await settings.load();

    expect(settings.get("volcengine-ark")).toEqual({ configured: false });
    expect(settings.get("byteplus-modelark")).toEqual({ configured: false });
    await settings.update("volcengine-ark", "  volc-key  ");
    await settings.update("byteplus-modelark", "byteplus-key");

    expect(JSON.parse(await readFile(path.join(directory, "seedance.json"), "utf8"))).toEqual({
      version: 1,
      volcengineApiKey: "volc-key",
      byteplusApiKey: "byteplus-key",
    });
    const restored = new SeedanceSettingsStore(directory);
    await restored.load();
    expect(restored.key("volcengine-ark")).toBe("volc-key");
    expect(restored.key("byteplus-modelark")).toBe("byteplus-key");

    await restored.clear("volcengine-ark");
    expect(restored.get("volcengine-ark")).toEqual({ configured: false });
    expect(restored.key("byteplus-modelark")).toBe("byteplus-key");
    await restored.clear("byteplus-modelark");
    await expect(access(path.join(directory, "seedance.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects empty keys and non-ASCII control characters", async () => {
    const settings = new SeedanceSettingsStore(await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-invalid-")));
    await expect(settings.update("volcengine-ark", "   ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("byteplus-modelark", "key\nvalue")).rejects.toThrow("printable ASCII");
  });

  it("preserves unknown data when both regional keys change and are cleared", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-preserve-"));
    try {
      const file = path.join(directory, "seedance.json");
      const future = { account: { region: "ark" }, migration: ["pending"] };
      await writeFile(file, JSON.stringify({ version: 1, volcengineApiKey: "ark", byteplusApiKey: "byteplus", future }));
      const settings = new SeedanceSettingsStore(directory);
      await settings.load();
      await Promise.all([settings.update("volcengine-ark", "new-ark"), settings.update("byteplus-modelark", "new-byteplus")]);
      const restored = new SeedanceSettingsStore(directory);
      await restored.load();
      expect(restored.key("volcengine-ark")).toBe("new-ark");
      expect(restored.key("byteplus-modelark")).toBe("new-byteplus");
      await Promise.all([restored.clear("volcengine-ark"), restored.clear("byteplus-modelark")]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, future });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves unreadable settings until an explicit successful reload", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-seedance-unreadable-"));
    try {
      const file = path.join(directory, "seedance.json");
      for (const text of ["{broken", "null", "[]", JSON.stringify({ version: 2, volcengineApiKey: "future" }), JSON.stringify({ version: 1, byteplusApiKey: { encrypted: "future" } })]) {
        await writeFile(file, text);
        const settings = new SeedanceSettingsStore(directory);
        await expect(settings.load()).rejects.toThrow();
        await expect(settings.update("volcengine-ark", "replacement")).rejects.toThrow("unreadable");
        await expect(settings.clear("byteplus-modelark")).rejects.toThrow("unreadable");
        expect(await readFile(file, "utf8")).toBe(text);
      }
      const settings = new SeedanceSettingsStore(directory);
      await settings.load().catch(() => {});
      await writeFile(file, JSON.stringify({ version: 1, byteplusApiKey: "keep" }));
      await settings.load();
      await settings.update("volcengine-ark", "ark");
      expect(settings.key("byteplus-modelark")).toBe("keep");
      await rm(file);
      await settings.load();
      expect(settings.get("volcengine-ark")).toEqual({ configured: false });
      expect(settings.get("byteplus-modelark")).toEqual({ configured: false });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

});


describe("Seedream/Seedance migration inspection", () => {
  const secret = "seedance-inspection-canary-never-echo";
  const image = "doubao-seedream-5-0-pro-260628", video = "doubao-seedance-2-5-260628";
  const byteplus = "dreamina-seedance-2-5-260628";
  const configuration = "plugin-store/configuration.json";
  const plugin = (fields: object) => ({ version: 1, plugins: { "ohmygame/seedance": fields } });
  const value = (key: string) => ({ type: "secret", value: key });

  async function bytes(directory: string) {
    const entries: Record<string, string> = {};
    for (const file of await readdir(directory, { recursive: true, withFileTypes: true }))
      entries[path.relative(directory, path.join(file.parentPath, file.name))] = file.isFile()
        ? (await readFile(path.join(file.parentPath, file.name))).toString("base64") : "directory";
    return entries;
  }
  async function fixture(files: Record<string, unknown>, check: (report: Awaited<ReturnType<typeof inspectSeedanceMigration>>, directory: string) => void | Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "seedance-inspection-"));
    try {
      for (const [name, data] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await writeFile(path.join(directory, name), typeof data === "string" ? data : JSON.stringify(data));
      }
      const before = await bytes(directory);
      const report = await inspectSeedanceMigration(directory);
      expect(JSON.stringify(report)).not.toContain(secret);
      await check(report, directory);
      expect(await bytes(directory)).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  it("maps the shared Ark key once, independent BytePlus key and both media defaults", async () => {
    await fixture({
      "seedance.json": { version: 1, volcengineApiKey: secret, byteplusApiKey: `${secret}-byteplus`, future: { secret } },
      [configuration]: plugin({ byteplusApiKey: value(`${secret}-byteplus`), unrelated: { type: "text", value: secret } }),
      "model-visibility.json": { version: 1, hidden: { "volcengine-ark": [image, video] }, disabled: ["volcengine-ark"], defaultImageModel: { provider: "volcengine-ark", id: image, metadata: secret }, defaultVideoModel: { provider: "byteplus-modelark", id: byteplus, metadata: secret } },
      "media-tasks/unconfirmed.json": { secret, status: "unconfirmed" },
    }, (report) => {
      expect(report.regions.map(({ source, target, key }) => ({ source, target, key }))).toEqual([
        { source: "volcengine-ark", target: "plugin.ohmygame.seedance.ark", key: "copy" },
        { source: "byteplus-modelark", target: "plugin.ohmygame.seedance.byteplus", key: "same" },
      ]);
      expect(report.regions[0].visibility).toMatchObject({ action: "copy", source: { enabled: false, hiddenModels: [image, video], unknownModels: 0 } });
      expect(report.defaultImageModel).toEqual({ action: "map", source: "volcengine-ark", target: "plugin.ohmygame.seedance.ark", model: image });
      expect(report.defaultVideoModel).toEqual({ action: "map", source: "byteplus-modelark", target: "plugin.ohmygame.seedance.byteplus", model: byteplus });
      expect(report.blockers).toEqual([]);
      expect(report).toMatchObject({ activation: "held", scope: "settings-only" });
      expect(report.remainingChecks).toContain("unfinished-jobs-and-recovery-journals");
    });
  });

  it("detects occupied keys and combined image/video visibility conflicts", async () => {
    await fixture({
      "seedance.json": { version: 1, volcengineApiKey: secret },
      [configuration]: plugin({ arkApiKey: value("different"), byteplusApiKey: value(secret) }),
      "model-visibility.json": { version: 1, hidden: { "volcengine-ark": [image], "plugin.ohmygame.seedance.ark": [video] } },
    }, (report) => {
      expect(report.regions.map(({ key }) => key)).toEqual(["conflict", "target-only"]);
      expect(report.blockers).toEqual(["volcengine-ark:key-conflict", "volcengine-ark:visibility-review-target"]);
    });
    await fixture({
      "model-visibility.json": { version: 1, hidden: { "volcengine-ark": [image, video], "plugin.ohmygame.seedance.ark": [video, image] }, disabled: ["volcengine-ark", "plugin.ohmygame.seedance.ark"] },
    }, (report) => {
      expect(report.regions[0].visibility?.action).toBe("same");
      expect(report.blockers).toEqual([]);
    });
  });

  it("rejects unknown, wrong-region and wrong-kind model references without echoing saved IDs", async () => {
    await fixture({
      "model-visibility.json": { version: 1, hidden: { "volcengine-ark": [secret], "plugin.ohmygame.seedance.byteplus": [image] }, defaultImageModel: { provider: "volcengine-ark", id: video }, defaultVideoModel: { provider: "byteplus-modelark", id: video } },
    }, (report) => {
      expect(report.blockers).toEqual(["volcengine-ark:visibility-unsupported-models", "byteplus-modelark:visibility-unsupported-models", "default-video-model-unsupported", "default-image-model-unsupported"]);
      expect(report.regions[0].visibility?.source.unknownModels).toBe(1);
    });
    for (const model of [{ provider: "byteplus-modelark", id: image }, { provider: "volcengine-ark", id: secret }]) {
      await fixture({ "model-visibility.json": { version: 1, hidden: {}, defaultImageModel: model } }, (report) => {
        expect(report.blockers).toEqual(["default-image-model-unsupported"]);
      });
    }
  });

  it("refuses invalid or incompatible keys without normalizing them", async () => {
    for (const key of [" ", "not\nprintable", "密钥", "x".repeat(4097)]) {
      await fixture({ "seedance.json": { version: 1, volcengineApiKey: key } }, (report) => {
        expect(report.regions[0].key).toBe("invalid");
      });
    }
    for (const key of [{ type: "text", value: secret }, value(""), value("x".repeat(4097))]) {
      await fixture({ [configuration]: plugin({ arkApiKey: key }) }, (report) => {
        expect(report.regions[0].key).toBe("invalid");
      });
    }
  });

  it("reports future or malformed stores without writes or parser input", async () => {
    for (const file of ["seedance.json", configuration, "model-visibility.json"]) {
      for (const data of [`{"${secret}": broken`, { version: 99, hidden: {}, plugins: {} }, { version: 1, volcengineApiKey: false, hidden: false, plugins: { bad: { key: { type: "future", value: secret } } } }]) {
        await fixture({ [file]: data }, (report) => {
          expect(report.blockers.some((code) => code.endsWith("unreadable"))).toBe(true);
        });
      }
    }
  });

  it("keeps unrelated defaults and missing stores unchanged", async () => {
    await fixture({ "model-visibility.json": { version: 1, hidden: {}, defaultImageModel: { provider: secret, id: secret }, defaultVideoModel: { provider: secret, id: secret } } }, (report) => {
      expect(report.defaultImageModel?.action).toBe("unchanged");
      expect(report.defaultVideoModel.action).toBe("unchanged");
      expect(report.blockers).toEqual([]);
    });
    await fixture({}, async (report, directory) => {
      expect(report.regions.map(({ key }) => key)).toEqual(["absent", "absent"]);
      expect(report.defaultImageModel?.action).toBe("absent");
      expect(report.defaultVideoModel.action).toBe("absent");
      await expect(inspectSeedanceMigration(path.join(directory, "missing"))).rejects.toThrow("existing");
    });
  });
});


describe("Seedance settings migration rehearsal", () => {
  const secret = "seedance-private-rehearsal-canary";
  const image = { provider: "volcengine-ark", id: "doubao-seedream-5-0-pro-260628", extra: { secret } };
  const video = { provider: "byteplus-modelark", id: "dreamina-seedance-2-0-260128", extra: { secret } };
  async function fixture(check: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "seedance-rehearsal-test-"));
    try {
      await mkdir(path.join(directory, "plugin-store"));
      await writeFile(path.join(directory, "seedance.json"), JSON.stringify({ version: 1, volcengineApiKey: secret, byteplusApiKey: `${secret}-byteplus`, extra: { secret } }));
      await writeFile(path.join(directory, "plugin-store/configuration.json"), JSON.stringify({ version: 1, plugins: { "ohmygame/seedance": { byteplusApiKey: { type: "secret", value: `${secret}-byteplus`, future: 42 }, other: { type: "text", value: secret } }, "other/plugin": { key: { type: "secret", value: secret } } }, extra: { secret } }));
      await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: { "volcengine-ark": [image.id], "byteplus-modelark": [video.id], other: ["unknown"] }, disabled: ["volcengine-ark", "other"], defaultImageModel: image, defaultVideoModel: video, future: { secret } }));
      await check(directory);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async function plan(directory: string) {
    const before = await settingsSnapshot(directory), report = await inspectSeedanceMigration(directory);
    expect(report.blockers).toEqual([]);
    const proposal = proposeSeedanceSettings(before, report);
    expect(proposal.counts).toEqual({ keys: 1, providerPreferences: 2, defaultImageModel: true, defaultVideoModel: true });
    expect([...proposal.changes.keys()]).not.toContain("seedance.json");
    return { before, ...proposal };
  }

  it("copies the Ark key once, preserves metadata and both defaults, reloads idempotently and rolls back exact bytes", async () => {
    await fixture(async (directory) => {
      const { before, changes } = await plan(directory);
      await prepareSettingsTransaction(directory, before, changes);
      expect(same(await settingsSnapshot(directory), before)).toBe(true);
      await resumeSettingsTransaction(directory);
      const expected = new Map([...before, ...changes]);
      expect(await settingsSnapshot(directory)).toEqual(expected);
      const configuration = JSON.parse((await readFile(path.join(directory, "plugin-store/configuration.json"), "utf8")));
      expect(configuration.plugins["ohmygame/seedance"]).toEqual({ arkApiKey: { type: "secret", value: secret }, byteplusApiKey: { type: "secret", value: `${secret}-byteplus`, future: 42 }, other: { type: "text", value: secret } });
      expect(configuration.extra).toEqual({ secret });
      expect(configuration.plugins["other/plugin"]).toEqual({ key: { type: "secret", value: secret } });
      const preferences = JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8"));
      expect(preferences.defaultImageModel).toEqual({ ...image, provider: "plugin.ohmygame.seedance.ark" });
      expect(preferences.defaultVideoModel).toEqual({ ...video, provider: "plugin.ohmygame.seedance.byteplus" });
      expect(preferences.hidden).toEqual({ "volcengine-ark": [image.id], "byteplus-modelark": [video.id], other: ["unknown"], "plugin.ohmygame.seedance.ark": [image.id], "plugin.ohmygame.seedance.byteplus": [video.id] });
      expect(preferences.disabled).toEqual(["volcengine-ark", "other", "plugin.ohmygame.seedance.ark"]);
      expect(preferences.future).toEqual({ secret });
      const reloaded = await inspectSeedanceMigration(directory);
      expect(reloaded.blockers).toEqual([]);
      expect(proposeSeedanceSettings(expected, reloaded).changes.size).toBe(0);
      await rollbackSettingsTransaction(directory);
      expect(await settingsSnapshot(directory)).toEqual(before);
      await forgetSettingsTransaction(directory);
      await expect(access(path.join(directory, SETTINGS_TRANSACTION_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("runs only on a disposable copy and redacts failed inspection", async () => {
    await fixture(async (directory) => {
      const before = await settingsSnapshot(directory);
      const report = await rehearseSeedanceMigration(directory);
      expect(report).toMatchObject({ status: "passed", activation: "held", proposed: { keys: 1, defaultImageModel: true, defaultVideoModel: true }, checks: { reload: true, idempotent: true, rollback: true, sourceUnchanged: true, cleanup: true } });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(await settingsSnapshot(directory)).toEqual(before);
      await writeFile(path.join(directory, "seedance.json"), `{"${secret}": broken`);
      const invalid = await settingsSnapshot(directory), blocked = await rehearseSeedanceMigration(directory);
      expect(blocked).toMatchObject({ status: "blocked", blockers: ["legacy-settings-unreadable"], checks: { sourceUnchanged: true, cleanup: true } });
      expect(JSON.stringify(blocked)).not.toContain(secret);
      expect(await settingsSnapshot(directory)).toEqual(invalid);
    });
  });

  it("recovers process termination at each settings write and final receipt", async () => {
    for (const boundary of ["plugin-store/configuration.json", "model-visibility.json", "applied"]) await fixture(async (directory) => {
      const { before, changes } = await plan(directory);
      await prepareSettingsTransaction(directory, before, changes);
      await killAt(directory, "resume", boundary, "seedance");
      await promisify(execFile)("node", ["--conditions=ohmygame-source", "--import", "tsx", "test/fixtures/media-settings-transaction-worker.cjs", directory, "startup", "none", "seedance"]);
      expect(await settingsSnapshot(directory)).toEqual(before);
      expect(await recoverInterruptedSeedanceSettings(directory)).toBe(false);
      await prepareSettingsTransaction(directory, before, changes);
      await resumeSettingsTransaction(directory);
      await commitSettingsTransaction(directory);
      expect(await hasCommittedSettingsTransaction(directory)).toBe(true);
      const receipt = JSON.parse(await readFile(path.join(directory, SETTINGS_TRANSACTION_BACKUP), "utf8"));
      expect(receipt.files["seedance.json"].before).toBe(before.get("seedance.json")!.toString("base64"));
      expect(receipt.files["seedance.json"].after).toBe(receipt.files["seedance.json"].before);
      await expect(access(path.join(directory, ".minimax-settings-committed-v1.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a changed source and checksum-valid attempts to modify the legacy file", async () => {
    for (const failure of ["source", "receipt"]) await fixture(async (directory) => {
      const { before, changes } = await plan(directory);
      await prepareSettingsTransaction(directory, before, changes);
      if (failure === "source") await writeFile(path.join(directory, "seedance.json"), "changed source");
      else {
        const file = path.join(directory, SETTINGS_TRANSACTION_FILE), receipt = JSON.parse(await readFile(file, "utf8"));
        receipt.files["seedance.json"].after = Buffer.from("changed source").toString("base64");
        const { checksum: _, ...payload } = receipt;
        receipt.checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        await writeFile(file, JSON.stringify(receipt));
      }
      const unchanged = await settingsSnapshot(directory);
      await expect(resumeSettingsTransaction(directory)).rejects.toThrow(failure === "source" ? "conflict" : "transition");
      expect(await settingsSnapshot(directory)).toEqual(unchanged);
    });
  });

  it("exercises Node rehearsal with no apply option or credential output", async () => {
    await fixture(async (directory) => {
      const before = await settingsSnapshot(directory);
      const run = (args: string[]) => promisify(execFile)("node", ["--conditions=ohmygame-source", "--import", "tsx", "scripts/rehearse-seedance-migration.ts", ...args]);
      const { stdout, stderr } = await run(["--data-dir", directory]);
      expect(JSON.parse(stdout)).toMatchObject({ status: "passed", checks: { rollback: true, sourceUnchanged: true } });
      expect(stdout).not.toContain(secret); expect(stderr).toBe("");
      await expect(run(["--data-dir", directory, "--apply", secret])).rejects.toMatchObject({ code: 2, stdout: "", stderr: expect.not.stringContaining(secret) });
      expect(await settingsSnapshot(directory)).toEqual(before);
    });
  });
});

describe("Seedance migration package verification", () => {
  const pin = SEEDANCE_MIGRATION_PACKAGES[0];
  async function fixture(check: (directory: string, root: string, verify: (expected?: string) => Promise<void>) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "seedance-package-"));
    const root = path.join(directory, "plugin-store/packages", pin.id, pin.version);
    try {
      await cp(path.resolve(".runtime/seedance-migration-packages", pin.version, "source"), root, { recursive: true });
      const index = new PluginIndex(path.join(directory, "plugin-store/index.json"));
      const result = await index.add(root);
      if (!result.ok) throw new Error("Invalid prepared Seedance fixture");
      expect(result.entry.digest).toBe(pin.digest);
      await writeFile(path.join(directory, "plugin-store/origins.json"), JSON.stringify({ [`${pin.id}@${pin.version}`]: { type: "npm", package: pin.package, version: pin.version, registry: "npmjs" } }));
      await writeFile(path.join(directory, "plugin-store/grants.json"), JSON.stringify({ schema: 2, plugins: { [pin.id]: { enabled: true, everyProject: true, allowed: capabilityGrants(result.entry.manifest), future: true } }, projects: {} }));
      await writeFile(path.join(directory, "seedance.json"), JSON.stringify({ version: 1, volcengineApiKey: "private-canary", byteplusApiKey: "other-private-canary" }));
      const bytes = async () => {
        const result: Record<string, string> = {};
        for (const file of await readdir(directory, { recursive: true, withFileTypes: true }))
          result[path.relative(directory, path.join(file.parentPath, file.name))] = file.isFile()
            ? (await readFile(path.join(file.parentPath, file.name))).toString("base64") : file.isSymbolicLink() ? "link" : "directory";
        return result;
      };
      await check(directory, root, async (expected) => {
        const before = await bytes();
        expect(await seedanceMigrationPackageIssue(directory)).toBe(expected);
        if (expected) expect(await migrateSeedanceSettings(directory)).toEqual({ status: "deferred", reasons: [expected] });
        expect(await bytes()).toEqual(before);
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  it("migrates both regional keys and defaults once, retaining source files and later user edits", async () => {
    await fixture(async (directory) => {
      const source = await readFile(path.join(directory, "seedance.json"));
      const untouched = await Promise.all(["index.json", "origins.json", "grants.json"].map(async (file) => [file, await readFile(path.join(directory, "plugin-store", file))] as const));
      const image = { provider: "volcengine-ark", id: "doubao-seedream-5-0-pro-260628", extra: "keep" };
      const video = { provider: "byteplus-modelark", id: "dreamina-seedance-2-0-260128", extra: "keep" };
      await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: { "volcengine-ark": [image.id] }, disabled: ["volcengine-ark"], defaultImageModel: image, defaultVideoModel: video, future: "keep" }));
      expect(await migrateSeedanceSettings(directory)).toEqual({ status: "migrated", reasons: [] });
      expect(await readFile(path.join(directory, "seedance.json"))).toEqual(source);
      for (const [file, bytes] of untouched) expect(await readFile(path.join(directory, "plugin-store", file))).toEqual(bytes);
      const configurationFile = path.join(directory, "plugin-store/configuration.json");
      const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
      expect(configuration.plugins[pin.id]).toEqual({ arkApiKey: { type: "secret", value: "private-canary" }, byteplusApiKey: { type: "secret", value: "other-private-canary" } });
      const preferences = JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8"));
      expect(preferences).toMatchObject({ future: "keep", defaultImageModel: { ...image, provider: "plugin.ohmygame.seedance.ark" }, defaultVideoModel: { ...video, provider: "plugin.ohmygame.seedance.byteplus" }, disabled: ["volcengine-ark", "plugin.ohmygame.seedance.ark"] });
      expect(await hasCommittedSettingsTransaction(directory)).toBe(true);
      delete configuration.plugins[pin.id].arkApiKey;
      const edited = JSON.stringify(configuration);
      await writeFile(configurationFile, edited);
      expect(await migrateSeedanceSettings(directory)).toEqual({ status: "committed", reasons: [] });
      expect(await readFile(configurationFile, "utf8")).toBe(edited);
    });
  });

  it.each(["safe-mode", "conflict", "unreadable"])("preserves settings and creates no receipt when %s prevents activation", async (failure) => {
    await fixture(async (directory) => {
      if (failure === "conflict") await writeFile(path.join(directory, "plugin-store/configuration.json"), JSON.stringify({ version: 1, plugins: { [pin.id]: { arkApiKey: { type: "secret", value: "different" } } } }));
      if (failure === "unreadable") await writeFile(path.join(directory, "seedance.json"), '{"private-canary": broken');
      const before = await settingsSnapshot(directory);
      const result = await migrateSeedanceSettings(directory, failure === "safe-mode");
      expect(result.status).toBe("deferred");
      expect(result.reasons).toContain(failure === "safe-mode" ? "plugin-safe-mode" : failure === "conflict" ? "volcengine-ark:key-conflict" : "legacy-settings-unreadable");
      expect(JSON.stringify(result)).not.toContain("private-canary");
      expect(await settingsSnapshot(directory)).toEqual(before);
      for (const name of [SETTINGS_TRANSACTION_FILE, SETTINGS_TRANSACTION_BACKUP]) await expect(access(path.join(directory, name))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("recovers and commits after activation is terminated before or after commit", async () => {
    for (const boundary of ["plugin-store/configuration.json", "applied", SETTINGS_TRANSACTION_BACKUP]) await fixture(async (directory) => {
      const before = await settingsSnapshot(directory);
      await killAt(directory, "activate", boundary, "seedance");
      const result = await migrateSeedanceSettings(directory);
      expect(result.status).toBe(boundary === SETTINGS_TRANSACTION_BACKUP ? "committed" : "migrated");
      expect(await hasCommittedSettingsTransaction(directory)).toBe(true);
      const receipt = JSON.parse(await readFile(path.join(directory, SETTINGS_TRANSACTION_BACKUP), "utf8"));
      for (const [file, bytes] of before) expect(receipt.files[file].before).toBe(bytes?.toString("base64") ?? null);
      expect(await readFile(path.join(directory, "seedance.json"))).toEqual(before.get("seedance.json"));
    });
  });

  it("restores an interrupted attempt before refusing a changed package", async () => {
    await fixture(async (directory, root) => {
      const before = await settingsSnapshot(directory);
      await killAt(directory, "activate", "plugin-store/configuration.json", "seedance");
      await writeFile(path.join(root, "media/adapter.js"), "changed after interruption");
      expect(await migrateSeedanceSettings(directory)).toEqual({ status: "deferred", reasons: ["plugin-package-mismatch"] });
      expect(await settingsSnapshot(directory)).toEqual(before);
      expect(await hasCommittedSettingsTransaction(directory)).toBe(false);
    });
  });

  it("recovers Seedance before MiniMax writes the shared plugin settings at startup", async () => {
    await fixture(async (directory) => {
      const minimax = MINIMAX_MIGRATION_PACKAGES.at(-1)!;
      const root = path.join(directory, "plugin-store/packages", minimax.id, minimax.version);
      await cp(path.resolve(".runtime/minimax-migration-packages", minimax.version, "source"), root, { recursive: true });
      const index = new PluginIndex(path.join(directory, "plugin-store/index.json"));
      await index.load(); const added = await index.add(root);
      if (!added.ok) throw new Error("Invalid MiniMax fixture");
      const originsFile = path.join(directory, "plugin-store/origins.json"), origins = JSON.parse(await readFile(originsFile, "utf8"));
      origins[`${minimax.id}@${minimax.version}`] = { type: "npm", package: minimax.package, version: minimax.version, registry: "npmjs" };
      await writeFile(originsFile, JSON.stringify(origins));
      const grantsFile = path.join(directory, "plugin-store/grants.json"), grants = JSON.parse(await readFile(grantsFile, "utf8"));
      grants.plugins[minimax.id] = { enabled: true, everyProject: true, allowed: capabilityGrants(added.entry.manifest) };
      await writeFile(grantsFile, JSON.stringify(grants));
      await writeFile(path.join(directory, "minimax.json"), JSON.stringify({ version: 1, globalApiKey: "minimax-canary" }));
      const before = await settingsSnapshot(directory), inspected = await inspectSeedanceMigration(directory);
      await prepareSettingsTransaction(directory, before, proposeSeedanceSettings(before, inspected).changes);
      await resumeSettingsTransaction(directory);
      const result = await migrateMediaSettingsAtStartup(directory);
      expect(result).toEqual({ minimax: { status: "migrated", reasons: [] }, seedance: { status: "migrated", reasons: [] } });
      const configuration = JSON.parse(await readFile(path.join(directory, "plugin-store/configuration.json"), "utf8"));
      expect(configuration.plugins[minimax.id].globalApiKey.value).toBe("minimax-canary");
      expect(configuration.plugins[pin.id].arkApiKey.value).toBe("private-canary");
      expect(configuration.plugins[pin.id].byteplusApiKey.value).toBe("other-private-canary");
      expect(await migrateMediaSettingsAtStartup(directory)).toEqual({ minimax: { status: "committed", reasons: [] }, seedance: { status: "committed", reasons: [] } });
    });
  });

  it("verifies actual npm bytes and their shared-key/model mapping without installing or changing settings", async () => {
    await fixture(async (_directory, root, verify) => {
      const manifest = JSON.parse(await readFile(path.join(root, ".ohmygame-plugin/plugin.json"), "utf8"));
      expect(manifest.beta).toBe(true);
      for (const region of SEEDANCE_MIGRATION_REGIONS) {
        const provider = manifest.contributes.providers.find((p: { id: string }) => `plugin.ohmygame.seedance.${p.id}` === region.target);
        expect(provider.apiKey).toBe(region.field);
        expect(manifest.configuration[region.field].type).toBe("secret");
        expect(provider.media.image?.models.map((m: { id: string }) => m.id) ?? []).toEqual([...region.imageModels]);
        expect(provider.media.video.models.map((m: { id: string }) => m.id)).toEqual([...region.videoModels]);
      }
      await verify();
    });
  });

  it.each([
    ["missing", "plugin-not-installed"], ["release", "plugin-release-not-reviewed"], ["ambiguous", "plugin-release-not-reviewed"],
    ["index-version", "plugin-index-needs-refresh"], ["index-api", "plugin-index-needs-refresh"], ["index-entry", "plugin-index-unreadable"],
    ["disabled", "plugin-not-enabled"], ["scope", "plugin-not-enabled"], ["permission", "plugin-permissions-missing"],
    ["grants-version", "plugin-grants-needs-refresh"], ["development", "plugin-source-not-reviewed"], ["registry", "plugin-source-not-reviewed"],
    ["root", "plugin-not-managed"], ["bytes", "plugin-package-mismatch"], ["metadata", "plugin-index-mismatch"], ["corrupt", "plugin-files-unreadable"],
  ])("refuses %s without changing files", async (failure, expected) => {
    await fixture(async (directory, root, verify) => {
      const edit = async (file: string, change: (value: any) => void) => {
        const location = path.join(directory, "plugin-store", file), data = JSON.parse(await readFile(location, "utf8"));
        change(data); await writeFile(location, JSON.stringify(data));
      };
      if (failure === "missing") await rm(path.join(directory, "plugin-store/index.json"));
      if (failure === "release") await edit("index.json", (v) => { v.entries[0].version = "0.2.0"; });
      if (failure === "ambiguous") await edit("index.json", (v) => { v.entries.push({ ...v.entries[0], version: "0.2.0" }); });
      if (failure === "index-version") await edit("index.json", (v) => { v.schema = 99; });
      if (failure === "index-api") await edit("index.json", (v) => { v.api = "2.7.0"; });
      if (failure === "index-entry") await edit("index.json", (v) => { v.entries.push(null); });
      if (failure === "disabled") await edit("grants.json", (v) => { v.plugins[pin.id].enabled = false; });
      if (failure === "scope") await edit("grants.json", (v) => { v.plugins[pin.id].everyProject = false; });
      if (failure === "permission") await edit("grants.json", (v) => { v.plugins[pin.id].allowed = []; });
      if (failure === "grants-version") await edit("grants.json", (v) => { v.schema = 99; });
      if (failure === "development") await edit("origins.json", (v) => { v[`${pin.id}@${pin.version}`] = { type: "development", folder: root }; });
      if (failure === "registry") await edit("origins.json", (v) => { v[`${pin.id}@${pin.version}`].registry = "unreviewed"; });
      if (failure === "root") await edit("index.json", (v) => { v.entries[0].root = directory; });
      if (failure === "bytes") await writeFile(path.join(root, "media/adapter.js"), "changed adapter");
      if (failure === "metadata") await edit("index.json", (v) => { v.entries[0].manifest.description = "Changed cached description"; });
      if (failure === "corrupt") await writeFile(path.join(directory, "plugin-store/index.json"), '{"private-canary": broken');
      await verify(expected);
    });
  });

  it("refuses linked managed packages without changing their targets", async () => {
    await fixture(async (_directory, root, verify) => {
      const outside = `${root}-outside`;
      await cp(root, outside, { recursive: true });
      await rm(root, { recursive: true });
      await symlink(outside, root, process.platform === "win32" ? "junction" : "dir");
      await verify("plugin-files-unreadable");
    });
  });
});
