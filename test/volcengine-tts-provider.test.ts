import { describe, expect, it, vi } from "vitest";
import { VolcengineTtsProvider } from "../src/daemon/volcengine-tts-provider.js";

const MODEL = { provider: "volcengine-tts", id: "seed-tts-2.0" } as const;

describe("Volcengine TTS provider", () => {
  it("sends the official v3 request and combines streamed audio chunks", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          [
            JSON.stringify({
              code: 0,
              data: Buffer.from("hello ").toString("base64"),
            }),
            JSON.stringify({
              code: 0,
              data: Buffer.from("world").toString("base64"),
              usage: { text_words: 4 },
            }),
            JSON.stringify({ code: 20_000_000, message: "OK" }),
          ].join("\n"),
          { status: 200, headers: { "x-tt-logid": "doubao-request-1" } },
        ),
      );
    const provider = new VolcengineTtsProvider(() => "doubao-key", request);

    await expect(
      provider.generate({
        operation: "speech",
        text: "  你好，旅行者  ",
        model: MODEL,
        voiceId: "zh_female_cancan_mars_bigtts",
        language: "zh-cn",
        style: "Warm storyteller",
        speed: 10,
        output: { format: "mp3", sampleRate: 24_000, channels: 1 },
      }),
    ).resolves.toEqual({
      bytes: Buffer.from("hello world"),
      mediaType: "audio/mpeg",
      model: MODEL,
      metadata: {
        sampleRate: 24_000,
        channels: 1,
        codec: "mp3",
        providerRequestId: "doubao-request-1",
        usageCharacters: 4,
      },
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
    );
    expect(init?.headers).toEqual(
      expect.objectContaining({
        "Content-Type": "application/json",
        "X-Api-Key": "doubao-key",
        "X-Api-Resource-Id": "seed-tts-2.0",
        "X-Api-Request-Id": expect.any(String),
      }),
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      req_params: {
        text: "你好，旅行者",
        speaker: "zh_female_cancan_mars_bigtts",
        audio_params: { format: "mp3", sample_rate: 24_000, speech_rate: 10 },
        additions: JSON.stringify({
          explicit_language: "zh-cn",
          context_texts: ["Warm storyteller"],
        }),
      },
    });
  });

  it("rejects unsupported operations, invalid inputs, and provider errors", async () => {
    const provider = new VolcengineTtsProvider(
      () => "key",
      vi.fn<typeof fetch>(),
    );
    await expect(
      provider.generate({
        operation: "sound-effect",
        prompt: "thunder",
        model: MODEL,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("speech generation only"),
    });
    await expect(
      provider.generate({
        operation: "speech",
        text: " ",
        model: MODEL,
        voiceId: "voice",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const failed = new VolcengineTtsProvider(
      () => "key",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            `${JSON.stringify({ code: 45000010, message: "Too many requests" })}\n`,
            { status: 200 },
          ),
        ),
    );
    await expect(
      failed.generate({
        operation: "speech",
        text: "hello",
        model: MODEL,
        voiceId: "voice",
      }),
    ).rejects.toMatchObject({ statusCode: 429, message: "Too many requests" });
  });

  it("uses the configured default Speaker ID when a request omits one", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `${JSON.stringify({ code: 0, data: Buffer.from("audio").toString("base64") })}\n`,
        ),
      );
    const provider = new VolcengineTtsProvider(
      () => "key",
      request,
      undefined,
      undefined,
      () => "zh_female_popo_mars_bigtts",
    );
    await provider.generate({
      operation: "speech",
      text: "你好",
      model: MODEL,
    });
    expect(
      JSON.parse(String(request.mock.calls[0]?.[1]?.body)).req_params.speaker,
    ).toBe("zh_female_popo_mars_bigtts");
  });
});
