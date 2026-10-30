import { describe, expect, it, vi } from "vitest";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";

import { mp3Fixture, wavFixture } from "./audio-fixtures.js";

const MODEL = {
  provider: "volcengine-seed-audio",
  id: "seed-audio-1.0",
} as const;
const MP3 = mp3Fixture(48000);

describe("Volcengine Seed Audio provider", () => {
  it("translates a sound-effect request to the official synchronous API", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          audio: MP3.toString("base64"),
          duration: 3.25,
          original_duration: 3.5,
        }),
        { status: 200, headers: { "x-tt-logid": "seed-audio-request-1" } },
      ),
    );
    const provider = new VolcengineSeedAudioProvider(() => "seed-key", request);

    await expect(
      provider.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "  Heavy castle door slams shut with a low stone echo  ",
        durationSeconds: 3,
        output: { format: "mp3", sampleRate: 48_000 },
      }),
    ).resolves.toEqual({
      bytes: MP3,
      mediaType: "audio/mpeg",
      model: MODEL,
      metadata: {
        durationMs: 3_250,
        originalDurationMs: 3_500,
        channels: 1,
        sampleRate: 48_000,
        codec: "mp3",
        providerRequestId: "seed-audio-request-1",
      },
    });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/tts/create");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "X-Api-Key": "seed-key",
        "X-Api-Request-Id": expect.any(String),
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "seed-audio-1.0",
      text_prompt:
        "Create a standalone game sound effect approximately 3 seconds long. Do not include speech, narration, singing, or background music. Description: Heavy castle door slams shut with a low stone echo",
      audio_config: {
        format: "mp3",
        sample_rate: 48_000,
        pitch_rate: 0,
        speech_rate: 0,
        loudness_rate: 0,
      },
      watermark: { aigc_watermark: false, aigc_metadata: { enable: true } },
    });
  });

  it("generates WAV instrumental music with capability-safe instructions", async () => {
    const wav = wavFixture(1, 24000);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ audio: wav.toString("base64") })),
      );
    const provider = new VolcengineSeedAudioProvider(() => "seed-key", request);

    const generated = await provider.generate({
      operation: "music",
      model: MODEL,
      prompt: "Quiet harbor theme with piano and strings",
      instrumental: true,
      durationSeconds: 30,
      output: { format: "wav", sampleRate: 24_000 },
    });
    expect(generated.mediaType).toBe("audio/wav");
    expect(
      JSON.parse(String(request.mock.calls[0]?.[1]?.body)).text_prompt,
    ).toContain("Do not include vocals, speech, narration, or lyrics");
  });

  it("rejects unsupported controls and invalid provider responses", async () => {
    const provider = new VolcengineSeedAudioProvider(
      () => "seed-key",
      vi.fn<typeof fetch>(),
    );
    await expect(
      provider.generate({
        operation: "music",
        model: MODEL,
        prompt: "theme",
        instrumental: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("instrumental music only"),
    });
    await expect(
      provider.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "rain",
        loop: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("seamless loops"),
    });
    await expect(
      provider.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "rain",
        durationSeconds: 121,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const invalid = new VolcengineSeedAudioProvider(
      () => "seed-key",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            audio: Buffer.from("not mp3").toString("base64"),
          }),
        ),
      ),
    );
    await expect(
      invalid.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "rain",
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("Invalid mp3 audio"),
    });
  });

  it("maps credentials, quota, and provider failures", async () => {
    const unauthorized = new VolcengineSeedAudioProvider(
      () => "seed-key",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("denied", { status: 403 })),
    );
    await expect(
      unauthorized.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "rain",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    const failed = new VolcengineSeedAudioProvider(
      () => "seed-key",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 55_001_309,
            message: "audio generate internal error",
          }),
        ),
      ),
    );
    await expect(
      failed.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "rain",
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: "audio generate internal error",
    });

    const limited = new VolcengineSeedAudioProvider(
      () => "seed-key",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("busy", { status: 429 })),
    );
    await expect(
      limited.generate({
        operation: "sound-effect",
        model: MODEL,
        prompt: "rain",
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
  });
});

describe("Seed Audio creative workflows", () => {
  it("keeps scene controls, metadata and Speaker IDs without reference media or subtitles", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ audio: wavFixture().toString("base64"), duration: 1, original_duration: 1.2, subtitle: { invalid: true } })));
    const provider = new VolcengineSeedAudioProvider(() => "key", request);
    const generated = await provider.generate({ operation: "audio-scene", model: MODEL, prompt: "Welcome over quiet rain", pitch: -3, volume: 20, speed: 10, output: { format: "wav", sampleRate: 48000 } });
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(body.text_prompt).toBe("Welcome over quiet rain");
    expect(body.audio_config).toMatchObject({ pitch_rate: -3, loudness_rate: 20, speech_rate: 10 });
    expect(body.audio_config).not.toHaveProperty("enable_subtitle");
    expect(body).not.toHaveProperty("references");
    expect(generated).not.toHaveProperty("subtitles");
    expect(generated.metadata).toMatchObject({ durationMs: 1000, originalDurationMs: 1200 });
    await provider.generate({ operation: "speech", model: MODEL, text: "Hello", voiceId: "S_existing_voice", output: { format: "wav", sampleRate: 48000 } });
    expect(JSON.parse(String(request.mock.calls[1]![1]!.body)).references).toEqual([{ speaker: "S_existing_voice" }]);
  });
  it("enforces the advertised user budget and format-specific sample rates", async () => {
    const request = vi.fn<typeof fetch>(), provider = new VolcengineSeedAudioProvider(() => "key", request);
    const maximum = provider.models()[0]!.capabilities.maxTextCharacters!;
    await expect(provider.generate({ operation: "sound-effect", model: MODEL, prompt: "a".repeat(maximum + 1) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(provider.generate({ operation: "sound-effect", model: MODEL, prompt: "rain", output: { format: "mp3", sampleRate: 40000 } })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValue(new Response(JSON.stringify({ audio: wavFixture(1, 40000).toString("base64") })));
    await expect(provider.generate({ operation: "sound-effect", model: MODEL, prompt: "a".repeat(maximum), durationSeconds: 0.5, output: { format: "wav", sampleRate: 40000 } })).resolves.toMatchObject({ metadata: { sampleRate: 40000 } });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).text_prompt.length).toBeLessThanOrEqual(3000);
  });
  it("rejects malformed bodies and invalid control ranges", async () => {
    for (const value of ["null", "[]", "not JSON", JSON.stringify({ audio: "SGVsbG8=$garbage" })]) {
      const provider = new VolcengineSeedAudioProvider(() => "key", vi.fn<typeof fetch>().mockResolvedValue(new Response(value)));
      await expect(provider.generate({ operation: "audio-scene", model: MODEL, prompt: "hello" })).rejects.toMatchObject({ statusCode: 502 });
    }
    const request = vi.fn<typeof fetch>(), provider = new VolcengineSeedAudioProvider(() => "key", request);
    for (const controls of [{ pitch: 13 }, { volume: -51 }, { speed: 0.5 }]) await expect(provider.generate({ operation: "audio-scene", model: MODEL, prompt: "hello", ...controls })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });
});

it("returns Ogg Opus as a playable Ogg file and restricts it to 48 kHz", async () => {
  const { opusFixture } = await import("./audio-fixtures.js");
  const bytes = await opusFixture();
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ audio: bytes.toString("base64") })));
  const provider = new VolcengineSeedAudioProvider(() => "key", request);
  await expect(provider.generate({ operation: "audio-scene", prompt: "hello", model: MODEL, output: { format: "ogg_opus", sampleRate: 48000 } })).resolves.toMatchObject({ bytes, mediaType: "audio/ogg", metadata: { sampleRate: 48000, codec: "ogg_opus" } });
  await expect(provider.generate({ operation: "audio-scene", prompt: "hello", model: MODEL, output: { format: "ogg_opus", sampleRate: 24000 } })).rejects.toMatchObject({ statusCode: 400 });
  expect(request).toHaveBeenCalledTimes(1);
});
