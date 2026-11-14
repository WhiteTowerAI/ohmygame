import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
