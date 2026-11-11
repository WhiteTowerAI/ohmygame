import { describe, expect, it } from "vitest";
import { currentAudioModel, migrateLegacyAudioJob, migrateLegacyAudioNodes } from "../src/shared/audio-legacy.js";

describe("saved audio compatibility", () => {
  it("folds old audio nodes into the unified node and turns transcriptions into text", () => {
    const model = { provider: "volcengine-seed-audio", id: "seed-audio-1.0" };
    const { value, migrated } = migrateLegacyAudioNodes({ nodes: [
      { id: "line", type: "speech", data: { text: "Welcome", model } },
      { id: "theme", type: "music", data: { prompt: "Harbor", model } },
      { id: "scene", type: "audio-scene", data: { prompt: "As written", model } },
      { id: "transcript", type: "transcription", data: { text: "Keep this transcript", audioAssetId: "line" } },
    ] });

    expect(migrated).toEqual(["line", "theme", "scene", "transcript"]);
    expect(value.nodes.map((node) => ({ type: node.type, prompt: (node.data as { prompt?: string }).prompt }))).toEqual([
      { type: "audio", prompt: "Speak the following text exactly. Welcome" },
      { type: "audio", prompt: "Create instrumental game background music. Do not include vocals, speech, narration, or lyrics. Description: Harbor" },
      { type: "audio", prompt: "As written" },
      { type: "text", prompt: undefined },
    ]);
    expect(value.nodes[3]).toEqual({ id: "transcript", type: "text", data: { text: "Keep this transcript", instruction: "" } });
    expect(value.nodes.slice(0, 3).map((node) => node.data.model)).toEqual([
      { provider: "volcengine-tts", id: "seed-audio-1.0" },
      { provider: "volcengine-tts", id: "seed-audio-1.0" },
      { provider: "volcengine-tts", id: "seed-audio-1.0" },
    ]);
  });

  it("reads saved model choices under their current providers", () => {
    const seedAudio = { provider: "volcengine-seed-audio", id: "seed-audio-1.0" };
    const elevenV2 = { provider: "elevenlabs", id: "eleven_text_to_sound_v2" };
    const { value, migrated } = migrateLegacyAudioNodes({ nodes: [
      { id: "seed", type: "audio", data: { prompt: "Rain", model: seedAudio } },
      { id: "birds", type: "audio", data: { prompt: "Birdsong", model: elevenV2 } },
    ] });

    expect(migrated).toEqual(["seed", "birds"]);
    expect(value.nodes.map((node) => node.data.model)).toEqual([
      { provider: "volcengine-tts", id: "seed-audio-1.0" },
      { provider: "elevenlabs", id: "eleven_text_to_sound_v3" },
    ]);
    expect(currentAudioModel(seedAudio)).toEqual({ provider: "volcengine-tts", id: "seed-audio-1.0" });
    expect(currentAudioModel(elevenV2)).toEqual({ provider: "elevenlabs", id: "eleven_text_to_sound_v3" });
  });

  it("reads earlier per-kind tool jobs as generate-audio", () => {
    expect(migrateLegacyAudioJob({ id: "j", toolId: "generate-speech", input: { text: "Hi", voiceId: "v" } }))
      .toEqual({ id: "j", toolId: "generate-audio", input: { prompt: "Hi", voiceId: "v", kind: "speech" } });
    expect(migrateLegacyAudioJob({ id: "m", toolId: "generate-music", input: { prompt: "Theme", lyrics: "la" } }))
      .toEqual({ id: "m", toolId: "generate-audio", input: { prompt: "Theme", kind: "music" } });
  });
});
