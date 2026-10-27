import { describe, expect, it } from "vitest";
import { VOLCENGINE_TTS_MODELS } from "../src/daemon/volcengine-tts-provider.js";
import { VOLCENGINE_TTS_VOICES } from "../src/shared/audio.js";
import {
  mergeVoiceCatalog,
  renderVoiceCatalog,
  signVolcengineRequest,
} from "../scripts/sync-doubao-voices.js";

describe("Volcengine TTS voice catalog", () => {
  it("lists the official seed-tts-2.0 preset voices", () => {
    expect(VOLCENGINE_TTS_VOICES.length).toBeGreaterThanOrEqual(240);
    const languages = VOLCENGINE_TTS_MODELS[0]!.capabilities.languages!;
    for (const voice of VOLCENGINE_TTS_VOICES) {
      expect(voice.id).toMatch(/^[a-z0-9_]+_uranus_bigtts$/);
      expect(voice.name.length).toBeGreaterThan(0);
      expect(languages).toContain(voice.language);
      expect(voice.id).toContain(
        voice.gender === "female" ? "_female_" : "_male_",
      );
      if (voice.trialUrl) expect(voice.trialUrl).toMatch(/^https:\/\//);
    }
    expect(new Set(VOLCENGINE_TTS_VOICES.map((voice) => voice.id)).size).toBe(
      VOLCENGINE_TTS_VOICES.length,
    );
    expect(
      VOLCENGINE_TTS_VOICES.filter((voice) => voice.dialects).map(
        (voice) => voice.id,
      ),
    ).toEqual([
      "zh_female_vv_uranus_bigtts",
      "zh_female_xiaohe_uranus_bigtts",
      "zh_male_m191_uranus_bigtts",
      "zh_male_taocheng_uranus_bigtts",
    ]);
  });

  it("refreshes names and official samples while keeping documented flags", () => {
    const merged = mergeVoiceCatalog(
      [
        {
          id: "zh_female_vv_uranus_bigtts",
          name: "Vivi",
          gender: "female",
          language: "zh-cn",
          dialects: true,
        },
        {
          id: "en_male_ryan_uranus_bigtts",
          name: "Ryan",
          gender: "male",
          language: "en",
          noInstructions: true,
        },
      ],
      [
        {
          VoiceType: "zh_female_vv_uranus_bigtts",
          Name: "Vivi 2.0",
          TrialURL: "https://example.com/vivi.mp3",
        },
        {
          VoiceType: "ja_female_new_uranus_bigtts",
          Name: "New",
          TrialURL: "http://insecure.example.com",
        },
        { VoiceType: "zh_female_old_mars_bigtts", Name: "1.0 voice" },
      ],
    );
    expect(merged).toEqual([
      {
        id: "zh_female_vv_uranus_bigtts",
        name: "Vivi",
        gender: "female",
        language: "zh-cn",
        dialects: true,
        trialUrl: "https://example.com/vivi.mp3",
      },
      {
        id: "en_male_ryan_uranus_bigtts",
        name: "Ryan",
        gender: "male",
        language: "en",
        noInstructions: true,
      },
      {
        id: "ja_female_new_uranus_bigtts",
        name: "New",
        gender: "female",
        language: "ja",
      },
    ]);
    expect(renderVoiceCatalog(merged)).toContain(
      '{ id: "ja_female_new_uranus_bigtts", name: "New", gender: "female", language: "ja" },',
    );
  });

  it("signs ListSpeakers requests with the documented header layout", () => {
    const headers = signVolcengineRequest({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      region: "cn-beijing",
      query: "Action=ListSpeakers&Version=2025-05-20",
      body: "{}",
      date: new Date("2026-01-05T07:23:05.123Z"),
    });
    expect(headers["X-Date"]).toBe("20260105T072305Z");
    expect(headers.Authorization).toMatch(
      /^HMAC-SHA256 Credential=AK\/20260105\/cn-beijing\/speech_saas_prod\/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/,
    );
  });
});
