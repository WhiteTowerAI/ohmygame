import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MinimaxSettingsStore } from "../src/daemon/minimax-settings.js";

describe("Minimax settings", () => {
  it("persists the domestic and international API keys independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-minimax-settings-"));
    const settings = new MinimaxSettingsStore(directory);
    await settings.load();

    expect(settings.get("minimax-video-cn")).toEqual({ configured: false });
    expect(settings.get("minimax-video-global")).toEqual({ configured: false });
    await settings.update("minimax-video-cn", "  cn-key  ");
    await settings.update("minimax-video-global", "global-key");

    expect(JSON.parse(await readFile(path.join(directory, "minimax.json"), "utf8"))).toEqual({
      version: 1,
      cnApiKey: "cn-key",
      globalApiKey: "global-key",
    });
    const restored = new MinimaxSettingsStore(directory);
    await restored.load();
    expect(restored.key("minimax-video-cn")).toBe("cn-key");
    expect(restored.key("minimax-video-global")).toBe("global-key");

    await restored.clear("minimax-video-cn");
    expect(restored.get("minimax-video-cn")).toEqual({ configured: false });
    expect(restored.key("minimax-video-global")).toBe("global-key");
    await restored.clear("minimax-video-global");
    await expect(access(path.join(directory, "minimax.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects empty keys and non-ASCII control characters", async () => {
    const settings = new MinimaxSettingsStore(await mkdtemp(path.join(tmpdir(), "ohmygame-minimax-invalid-")));
    await expect(settings.update("minimax-video-cn", "   ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("minimax-video-global", "key\nvalue")).rejects.toThrow("printable ASCII");
  });
});

describe("MiniMax settings preservation", () => {
  it("retains unknown data when both keys are changed and cleared", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "minimax-preserve-"));
    try {
      const file = path.join(directory, "minimax.json");
      const future = { account: { region: "cn" }, migration: ["pending"] };
      await writeFile(file, JSON.stringify({ version: 1, cnApiKey: "cn", globalApiKey: "global", future }));
      const settings = new MinimaxSettingsStore(directory);
      await settings.load();
      await Promise.all([settings.update("minimax-video-cn", "new-cn"), settings.update("minimax-video-global", "new-global")]);
      const restored = new MinimaxSettingsStore(directory);
      await restored.load();
      expect(restored.key("minimax-video-cn")).toBe("new-cn");
      expect(restored.key("minimax-video-global")).toBe("new-global");
      await Promise.all([restored.clear("minimax-video-cn"), restored.clear("minimax-video-global")]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, future });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses mutations after unreadable data without replacing the original bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "minimax-unreadable-"));
    try {
      const file = path.join(directory, "minimax.json");
      for (const text of ["{broken", "null", "[]", JSON.stringify({ version: 2, cnApiKey: "future" }), JSON.stringify({ version: 1, cnApiKey: { encrypted: "future" } })]) {
        await writeFile(file, text);
        const settings = new MinimaxSettingsStore(directory);
        await expect(settings.load()).rejects.toThrow();
        await expect(settings.update("minimax-video-cn", "replacement")).rejects.toThrow("unreadable");
        await expect(settings.clear("minimax-video-global")).rejects.toThrow("unreadable");
        expect(await readFile(file, "utf8")).toBe(text);
      }
      // Explicitly reloading a repaired file restores normal writes.
      const settings = new MinimaxSettingsStore(directory);
      await settings.load().catch(() => {});
      await writeFile(file, JSON.stringify({ version: 1, globalApiKey: "keep" }));
      await settings.load();
      await settings.update("minimax-video-cn", "cn");
      expect(settings.key("minimax-video-global")).toBe("keep");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
