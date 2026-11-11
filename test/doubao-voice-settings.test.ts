import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DoubaoVoiceSettingsStore } from "../src/daemon/doubao-voice-settings.js";

const directory = (name: string) =>
  mkdtemp(path.join(tmpdir(), `ohmygame-doubao-${name}-`));

describe("Doubao Voice settings", () => {
  it("shares one key, never exposes it, and clears both services together", async () => {
    const root = await directory("shared");
    const settings = new DoubaoVoiceSettingsStore(root);
    await settings.load();
    expect(settings.get()).toEqual({ configured: false, distinctKeys: false });

    await settings.update("  shared-secret  ");
    expect(settings.key("volcengine-tts")).toBe("shared-secret");
    expect(settings.key("volcengine-seed-audio")).toBe("shared-secret");
    expect(settings.get()).toEqual({ configured: true, distinctKeys: false });
    expect(JSON.stringify(settings.get())).not.toContain("secret");
    await settings.setDefaultVoice("zh_male_m191_uranus_bigtts");

    await settings.clear();
    expect(settings.key("volcengine-tts")).toBeUndefined();
    expect(settings.key("volcengine-seed-audio")).toBeUndefined();
    expect(settings.get()).toEqual({ configured: false, distinctKeys: false, defaultVoiceId: "zh_male_m191_uranus_bigtts" });
    await expect(settings.update(" ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("bad\nkey")).rejects.toThrow("printable ASCII");
  });

  it("keeps per-service keys saved apart until a new key replaces them", async () => {
    const root = await directory("services");
    await writeFile(path.join(root, "doubao-voice.json"), JSON.stringify({
      version: 1, apiKey: "shared", services: { "volcengine-tts": "tts-only", "volcengine-seed-audio": null },
    }));
    const settings = new DoubaoVoiceSettingsStore(root);
    await settings.load();
    expect(settings.key("volcengine-tts")).toBe("tts-only");
    expect(settings.key("volcengine-seed-audio")).toBeUndefined();
    expect(settings.get()).toEqual({ configured: true, distinctKeys: false });
    await writeFile(path.join(root, "doubao-voice.json"), JSON.stringify({ version: 1, services: { "volcengine-tts": "a", "volcengine-seed-audio": "b" } }));
    const distinct = new DoubaoVoiceSettingsStore(root);
    await distinct.load();
    expect(distinct.get()).toMatchObject({ configured: true, distinctKeys: true });
    await distinct.update("next");
    expect([distinct.key("volcengine-tts"), distinct.key("volcengine-seed-audio")]).toEqual(["next", "next"]);
    expect(JSON.parse(await readFile(path.join(root, "doubao-voice.json"), "utf8"))).toEqual({ version: 1, apiKey: "next", services: {} });
  });

  it("saves the default voice without re-entering the API key", async () => {
    const settings = new DoubaoVoiceSettingsStore(await directory("voice"));
    await settings.load();
    await expect(
      settings.setDefaultVoice("zh_male_m191_uranus_bigtts"),
    ).rejects.toThrow("Connect Doubao speech synthesis");
    await settings.update("secret-key");
    await settings.setDefaultVoice("zh_male_m191_uranus_bigtts");
    expect(settings.get().defaultVoiceId).toBe("zh_male_m191_uranus_bigtts");
    expect(settings.key("volcengine-tts")).toBe("secret-key");
    await settings.setDefaultVoice(null);
    expect(settings.defaultVoiceId()).toBeUndefined();
    await expect(settings.setDefaultVoice("invalid voice id")).rejects.toThrow(
      "Speaker ID",
    );
  });

  it("migrates distinct legacy keys and the default voice, then removes the old files", async () => {
    const root = await directory("legacy");
    await writeFile(
      path.join(root, "volcengine-tts.json"),
      JSON.stringify({
        version: 1,
        apiKey: "tts-secret",
        defaultVoiceId: "zh_female_vv_uranus_bigtts",
      }),
    );
    await writeFile(
      path.join(root, "volcengine-seed-audio.json"),
      JSON.stringify({ version: 1, apiKey: "seed-secret" }),
    );
    const settings = new DoubaoVoiceSettingsStore(root);
    await settings.load();
    expect(settings.key("volcengine-tts")).toBe("tts-secret");
    expect(settings.key("volcengine-seed-audio")).toBe("seed-secret");
    expect(settings.get()).toMatchObject({
      distinctKeys: true,
      defaultVoiceId: "zh_female_vv_uranus_bigtts",
    });
    for (const file of ["volcengine-tts.json", "volcengine-seed-audio.json"])
      await expect(access(path.join(root, file))).rejects.toMatchObject({
        code: "ENOENT",
      });
    const saved = JSON.parse(
      await readFile(path.join(root, "doubao-voice.json"), "utf8"),
    );
    expect(saved.services).toEqual({
      "volcengine-tts": "tts-secret",
      "volcengine-seed-audio": "seed-secret",
    });
  });

  it("turns equal legacy keys into the shared key and keeps a single service separate", async () => {
    const shared = await directory("legacy-shared");
    for (const file of ["volcengine-tts.json", "volcengine-seed-audio.json"])
      await writeFile(
        path.join(shared, file),
        JSON.stringify({ version: 1, apiKey: "same" }),
      );
    const settings = new DoubaoVoiceSettingsStore(shared);
    await settings.load();
    expect(settings.get()).toMatchObject({ distinctKeys: false });
    expect(
      JSON.parse(
        await readFile(path.join(shared, "doubao-voice.json"), "utf8"),
      ),
    ).toEqual({ version: 1, apiKey: "same", services: {} });

    const single = await directory("legacy-single");
    await writeFile(
      path.join(single, "volcengine-seed-audio.json"),
      JSON.stringify({ version: 1, apiKey: "seed-only" }),
    );
    const seedOnly = new DoubaoVoiceSettingsStore(single);
    await seedOnly.load();
    expect(seedOnly.key("volcengine-seed-audio")).toBe("seed-only");
    expect(seedOnly.key("volcengine-tts")).toBeUndefined();
  });
});
