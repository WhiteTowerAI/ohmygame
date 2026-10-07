import { access, mkdtemp, readFile } from "node:fs/promises";
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
});
