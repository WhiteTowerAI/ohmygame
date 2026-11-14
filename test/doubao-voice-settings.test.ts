import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectDoubaoMigration } from "../scripts/inspect-doubao-migration.js";
import { snapshot, same } from "../src/daemon/media-settings-snapshot.js";
import { DOUBAO_MIGRATION_FILES } from "../src/daemon/doubao-migration-settings.js";
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

describe("read-only Doubao plugin migration inspection", () => {
  const pluginId = "ohmygame/doubao-voice";
  const target = "plugin.ohmygame.doubao-voice.doubao-voice";
  async function inspect(files: Record<string, unknown>, check: (report: Awaited<ReturnType<typeof inspectDoubaoMigration>>) => void) {
    const root = await directory("inspection");
    try {
      for (const [file, value] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), JSON.stringify(value));
      }
      const before = await snapshot(root, DOUBAO_MIGRATION_FILES);
      const report = await inspectDoubaoMigration(root);
      expect(same(before, await snapshot(root, DOUBAO_MIGRATION_FILES), DOUBAO_MIGRATION_FILES)).toBe(true);
      expect(report.activation).toBe("held");
      expect(JSON.stringify(report)).not.toMatch(/private-key|private-voice|unknown-private|unrelated-private/);
      check(report);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  it("reads equal separate keys and merges known visibility/default proposals without writing any files", async () => {
    await inspect({
      "volcengine-tts.json": { version: 1, apiKey: "private-key", defaultVoiceId: "private-voice" },
      "volcengine-seed-audio.json": { version: 1, apiKey: "private-key" },
      "model-visibility.json": { version: 1, hidden: { "volcengine-tts": ["seed-tts-2.0"] }, defaultSpeechModel: { provider: "volcengine-tts", id: "seed-tts-2.0", future: "unrelated-private" }, defaultMusicModel: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" } },
    }, report => {
      expect(report.blockers).toEqual([]);
      expect(report).toMatchObject({ connection: "shared", key: "copy", defaultVoice: "copy", visibility: { action: "copy", hiddenModels: ["seed-tts-2.0"] }, defaultAudioModels: { speech: { action: "map", target }, music: { action: "map", target } } });
    });
  });
  it.each([
    [{ "volcengine-tts": null }, "separate-service-connection"],
    [{ "volcengine-seed-audio": null }, "separate-service-connection"],
    [{ "volcengine-tts": "different-private-key" }, "distinct-service-keys"],
    [{ "volcengine-tts": null, "volcengine-seed-audio": null }, undefined],
  ])("keeps current service overrides authoritative over stale legacy keys: %j", async (services, blocker) => {
    await inspect({
      "doubao-voice.json": { version: 1, apiKey: "private-key", services },
      "volcengine-tts.json": { version: 1, apiKey: "old-private-key", defaultVoiceId: "private-voice" },
      "volcengine-seed-audio.json": { version: 1, apiKey: "old-private-key" },
    }, report => {
      expect(report.blockers).toEqual(blocker ? [blocker] : []);
      expect(report.key).toBe(blocker ? "blocked" : "absent");
      expect(report.defaultVoice).toBe("copy");
    });
  });
  it("holds a single legacy connection and separate provider switches", async () => {
    await inspect({
      "volcengine-tts.json": { version: 1, apiKey: "private-key" },
      "model-visibility.json": { version: 1, hidden: {}, disabled: ["volcengine-seed-audio"] },
    }, report => expect(report.blockers).toEqual(["separate-service-connection", "visibility-legacy-visibility-conflict"]));
  });
  it("recognizes matching combined target settings without confusing the other model with an unknown ID", async () => {
    await inspect({
      "doubao-voice.json": { version: 1, apiKey: "private-key", services: {}, defaultVoiceId: "private-voice" },
      "plugin-store/configuration.json": { version: 1, plugins: { [pluginId]: { apiKey: { type: "secret", value: "private-key" }, defaultVoiceId: { type: "text", value: "private-voice" } } } },
      "model-visibility.json": { version: 1, hidden: { "volcengine-tts": ["seed-audio-1.0"], [target]: ["seed-audio-1.0"] } },
    }, report => {
      expect(report.blockers).toEqual([]);
      expect(report).toMatchObject({ key: "same", defaultVoice: "same", visibility: { action: "same" } });
    });
  });
  it("maps current Seed Audio choices under the shared provider and preserves a current disabled switch without requiring a legacy switch", async () => {
    await inspect({
      "doubao-voice.json": { version: 1, apiKey: "private-key", services: {} },
      "model-visibility.json": { version: 1, hidden: { "volcengine-tts": ["seed-audio-1.0"] }, disabled: ["volcengine-tts"], defaultMusicModel: { provider: "volcengine-tts", id: "seed-audio-1.0" } },
    }, report => {
      expect(report.blockers).toEqual([]);
      expect(report.visibility).toMatchObject({ action: "copy", enabled: false, hiddenModels: ["seed-audio-1.0"] });
      expect(report.defaultAudioModels.music).toEqual({ action: "map", source: "volcengine-tts", target, model: "seed-audio-1.0" });
    });
  });
  it("holds conflicting target credentials, voice and visibility without leaking stored values", async () => {
    await inspect({
      "doubao-voice.json": { version: 1, apiKey: "private-key", services: {}, defaultVoiceId: "private-voice" },
      "plugin-store/configuration.json": { version: 1, plugins: { [pluginId]: { apiKey: { type: "secret", value: "other-private-key" }, defaultVoiceId: { type: "text", value: "other-private-voice" } } } },
      "model-visibility.json": { version: 1, hidden: {}, disabled: [target] },
    }, report => expect(report.blockers).toEqual(["key-conflict", "default-voice-conflict", "visibility-review-target"]));
  });
  it.each([
    ["doubao-voice.json", { version: 2, services: {} }, "legacy-settings-unreadable"],
    ["volcengine-tts.json", { version: 2, apiKey: "private-key" }, "legacy-settings-unreadable"],
    ["volcengine-seed-audio.json", { version: 2 }, "legacy-settings-unreadable"],
    ["doubao-voice.json", { version: 1, services: [] }, "legacy-settings-unreadable"],
    ["doubao-voice.json", { version: 1, services: { future: null } }, "legacy-settings-unknown-fields"],
    ["doubao-voice.json", { version: 1, services: {}, future: "unknown-private" }, "legacy-settings-unknown-fields"],
    ["doubao-voice.json", { version: 1, services: {}, apiKey: "private-key\n" }, "key-invalid"],
    ["doubao-voice.json", { version: 1, services: {}, defaultVoiceId: "private-voice invalid" }, "default-voice-invalid"],
    ["plugin-store/configuration.json", { version: 2, plugins: {} }, "plugin-settings-unreadable"],
    ["plugin-store/configuration.json", { version: 1, plugins: { [pluginId]: { defaultVoiceId: { type: "secret", value: "private-voice" } } } }, "default-voice-invalid"],
    ["model-visibility.json", { version: 2, hidden: {} }, "model-preferences-unreadable"],
    ["model-visibility.json", { version: 1, hidden: { [target]: ["unknown-private"] } }, "visibility-unsupported-models"],
    ["model-visibility.json", { version: 1, hidden: {}, defaultMusicModel: { provider: "volcengine-tts", id: "seed-tts-2.0" } }, "default-music-model-unsupported"],
    ["model-visibility.json", { version: 1, hidden: {}, defaultSpeechModel: { provider: "volcengine-seed-audio", id: "seed-tts-2.0" } }, "default-speech-model-unsupported"],
  ])("holds incompatible %s data (%#) unchanged", async (file, value, blocker) => {
    await inspect({ [file]: value }, report => expect(report.blockers).toContain(blocker));
  });
  it("rejects a linked settings file before reading its content", async () => {
    const root = await directory("linked-inspection");
    try {
      await writeFile(path.join(root, "outside"), "private-key");
      await symlink(path.join(root, "outside"), path.join(root, "doubao-voice.json"));
      await expect(inspectDoubaoMigration(root)).rejects.toThrow("Invalid settings file");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
