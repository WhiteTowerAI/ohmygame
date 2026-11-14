import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
