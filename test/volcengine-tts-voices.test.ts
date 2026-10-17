import { describe, expect, it } from "vitest";
import { VOLCENGINE_TTS_VOICES } from "../src/shared/audio.js";

describe("Volcengine TTS voice catalog", () => {
  it("lists the official seed-tts-2.0 preset voices", () => {
    expect(VOLCENGINE_TTS_VOICES.length).toBeGreaterThanOrEqual(90);
    for (const voice of VOLCENGINE_TTS_VOICES) {
      expect(voice.id).toMatch(/^[a-z0-9_]+_uranus_bigtts$/);
      expect(voice.name.length).toBeGreaterThan(0);
      expect(["zh-cn", "en"]).toContain(voice.language);
      expect(["female", "male"]).toContain(voice.gender);
      expect(voice.id.startsWith(voice.language === "en" ? "en_" : "zh_")).toBe(
        true,
      );
      expect(voice.id).toContain(voice.gender === "female" ? "female" : "male");
    }
    const ids = new Set(VOLCENGINE_TTS_VOICES.map((voice) => voice.id));
    expect(ids.size).toBe(VOLCENGINE_TTS_VOICES.length);
    const names = new Set(VOLCENGINE_TTS_VOICES.map((voice) => voice.name));
    expect(names.size).toBe(VOLCENGINE_TTS_VOICES.length);
  });

  it("includes the default and flagship voices", () => {
    const ids = new Set(VOLCENGINE_TTS_VOICES.map((voice) => voice.id));
    expect(ids.has("zh_female_vv_uranus_bigtts")).toBe(true);
    expect(ids.has("zh_female_xiaohe_uranus_bigtts")).toBe(true);
    expect(ids.has("zh_male_m191_uranus_bigtts")).toBe(true);
    expect(ids.has("en_male_tim_uranus_bigtts")).toBe(true);
  });
});
