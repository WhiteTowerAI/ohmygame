import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VolcengineTtsSettingsStore } from "../src/daemon/volcengine-tts-settings.js";

describe("Volcengine TTS settings", () => {
  it("persists and clears the API key without exposing it", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-volcengine-tts-"),
    );
    const settings = new VolcengineTtsSettingsStore(directory);
    await settings.load();
    expect(settings.get()).toEqual({ configured: false });

    await settings.update("  secret-key  ", " zh_female_popo_mars_bigtts ");
    expect(settings.get()).toEqual({
      configured: true,
      defaultVoiceId: "zh_female_popo_mars_bigtts",
    });
    expect(
      JSON.parse(
        await readFile(path.join(directory, "volcengine-tts.json"), "utf8"),
      ),
    ).toEqual({
      version: 1,
      apiKey: "secret-key",
      defaultVoiceId: "zh_female_popo_mars_bigtts",
    });

    const restored = new VolcengineTtsSettingsStore(directory);
    await restored.load();
    expect(restored.key()).toBe("secret-key");
    expect(restored.defaultVoiceId()).toBe("zh_female_popo_mars_bigtts");
    await restored.clear();
    await expect(
      access(path.join(directory, "volcengine-tts.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects empty and control-character keys", async () => {
    const settings = new VolcengineTtsSettingsStore(
      await mkdtemp(path.join(tmpdir(), "ohmygame-volcengine-tts-invalid-")),
    );
    await expect(settings.update(" ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("key\nvalue")).rejects.toThrow(
      "printable ASCII",
    );
    await expect(settings.update("key", "invalid voice id")).rejects.toThrow(
      "Speaker ID",
    );
  });

  it("updates the default voice without re-entering the API key", async () => {
    const settings = new VolcengineTtsSettingsStore(
      await mkdtemp(path.join(tmpdir(), "ohmygame-volcengine-tts-voice-")),
    );
    await settings.load();
    await settings.update("secret-key", "zh_female_popo_mars_bigtts");

    await settings.update(undefined, "zh_male_m191_uranus_bigtts");
    expect(settings.get()).toEqual({
      configured: true,
      defaultVoiceId: "zh_male_m191_uranus_bigtts",
    });
    expect(settings.key()).toBe("secret-key");

    await settings.update(undefined, null);
    expect(settings.get()).toEqual({ configured: true });
    expect(settings.defaultVoiceId()).toBeUndefined();

    await expect(
      settings.update(undefined, "invalid voice id"),
    ).rejects.toThrow("Speaker ID");
    await expect(
      new VolcengineTtsSettingsStore(
        await mkdtemp(path.join(tmpdir(), "ohmygame-volcengine-tts-nokey-")),
      ).update(undefined, "zh_male_m191_uranus_bigtts"),
    ).rejects.toThrow("API key");
  });
});
