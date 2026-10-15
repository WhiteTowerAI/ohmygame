import { access, mkdtemp, readFile } from "node:fs/promises";
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
