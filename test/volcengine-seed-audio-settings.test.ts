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
