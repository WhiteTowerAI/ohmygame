import { describe, expect, it, vi } from "vitest";
import { VolcengineSeedAudioProvider } from "../src/daemon/volcengine-seed-audio-provider.js";

const MODEL = {
  provider: "volcengine-seed-audio",
  id: "seed-audio-1.0",
} as const;
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);

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
        enable_subtitle: false,
      },
      watermark: { aigc_watermark: false, aigc_metadata: { enable: true } },
    });
  });

  it("generates WAV instrumental music with capability-safe instructions", async () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
      Buffer.alloc(8),
    ]);
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
      message: expect.stringContaining("instrumental only"),
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
      message: expect.stringContaining("not valid MP3"),
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
