import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VolcengineSeedAudioSettingsStore } from "../src/daemon/volcengine-seed-audio-settings.js";

describe("Volcengine Seed Audio settings", () => {
  it("persists and clears the API key without exposing it", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-volcengine-seed-audio-"),
    );
    const settings = new VolcengineSeedAudioSettingsStore(directory);
    await settings.load();
    expect(settings.get()).toEqual({ configured: false });

    await settings.update("  seed-secret  ");
    expect(settings.get()).toEqual({ configured: true });
    expect(
      JSON.parse(
        await readFile(
          path.join(directory, "volcengine-seed-audio.json"),
          "utf8",
        ),
      ),
    ).toEqual({ version: 1, apiKey: "seed-secret" });

    const restored = new VolcengineSeedAudioSettingsStore(directory);
    await restored.load();
    expect(restored.key()).toBe("seed-secret");
    expect(restored.get()).toEqual({ configured: true });
    await restored.clear();
    await expect(
      access(path.join(directory, "volcengine-seed-audio.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects empty and control-character keys", async () => {
    const settings = new VolcengineSeedAudioSettingsStore(
      await mkdtemp(
        path.join(tmpdir(), "ohmygame-volcengine-seed-audio-invalid-"),
      ),
    );
    await expect(settings.update(" ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("key\nvalue")).rejects.toThrow(
      "printable ASCII",
    );
  });
});

describe("shared Doubao Voice connection", () => {
  it("preserves distinct legacy keys and supports shared credentials with service overrides", async () => {
    const { DoubaoVoiceSettingsStore } = await import("../src/daemon/doubao-voice-settings.js");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-doubao-shared-"));
    const settings = new DoubaoVoiceSettingsStore(directory);
    await settings.load({ "volcengine-tts": "tts-secret", "volcengine-seed-audio": "seed-secret" });
    expect(settings.key("volcengine-tts")).toBe("tts-secret");
    expect(settings.key("volcengine-seed-audio")).toBe("seed-secret");
    expect(settings.get()).toMatchObject({ distinctKeys: true, ttsConfigured: true, seedConfigured: true });
    expect(JSON.stringify(settings.get())).not.toContain("secret");
    await settings.setService("volcengine-tts", "tts-override");
    const restored = new DoubaoVoiceSettingsStore(directory);
    await restored.load({});
    expect(restored.key("volcengine-tts")).toBe("tts-override");
    expect(restored.key("volcengine-seed-audio")).toBe("seed-secret");
    await restored.update("shared-secret");
    expect(restored.get()).toMatchObject({ shared: true, distinctKeys: false });
    await restored.setService("volcengine-tts", null);
    expect(restored.key("volcengine-tts")).toBeUndefined();
    expect(restored.key("volcengine-seed-audio")).toBe("shared-secret");
    const again = new DoubaoVoiceSettingsStore(directory); await again.load({ "volcengine-tts": "stale" });
    expect(again.key("volcengine-tts")).toBeUndefined();
    expect(again.key("volcengine-seed-audio")).toBe("shared-secret");
    await expect(again.update("bad\nkey")).rejects.toThrow("printable ASCII");
  });
});
