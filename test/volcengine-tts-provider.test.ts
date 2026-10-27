import { describe, expect, it, vi } from "vitest";
import { VolcengineTtsProvider } from "../src/daemon/volcengine-tts-provider.js";

import { mp3Fixture } from "./audio-fixtures.js";
const MP3 = mp3Fixture();

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
              data: MP3.subarray(0, 311).toString("base64"),
            }),
            JSON.stringify({
              code: 0,
              data: MP3.subarray(311).toString("base64"),
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
      bytes: MP3,
      mediaType: "audio/mpeg",
      model: MODEL,
      metadata: {
        sampleRate: 24_000,
        durationMs: 240,
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

    // Official codes: 4xxxxxxx are request errors, 5xxxxxxx service errors; some causes are only in the message.
    for (const [code, message, statusCode] of [
      [45000000, "quota exceeded for types: concurrency", 429],
      [40402003, "TTSExceededTextLimit:exceed max limit", 400],
      [55000000, "resource ID is mismatched with speaker related resource", 503],
      [55000000, "Request timeout: synthesis processing timeout", 502],
    ] as const) {
      const failed = new VolcengineTtsProvider(
        () => "key",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(`${JSON.stringify({ code, message })}\n`, {
              status: 200,
            }),
          ),
      );
      await expect(
        failed.generate({
          operation: "speech",
          text: "hello",
          model: MODEL,
          voiceId: "voice",
        }),
      ).rejects.toMatchObject({ statusCode, message });
    }
  });

  it("uses the configured default Speaker ID when a request omits one", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          `${JSON.stringify({ code: 0, data: MP3.toString("base64") })}\n`,
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

describe("TTS voice controls and persistent subtitles", () => {
  it("maps pitch, loudness, pronunciation, dialect, language and subtitle options", async () => {
    const response = () => new Response([
      JSON.stringify({ code: 0, data: MP3.toString("base64"), sentence: { text: "Hello", words: [{ word: "Hello", startTime: 0.02, endTime: 0.2, confidence: 0.9 }] } }),
      JSON.stringify({ code: 20000000, usage: { text_words: 5 } }),
    ].join("\n"));
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const provider = new VolcengineTtsProvider(() => "key", request);
    const generated = await provider.generate({ operation: "speech", model: MODEL, text: "Hello", voiceId: "zh_female_vv_uranus_bigtts", language: "en", autoLanguage: true, dialect: "yue", pitch: -4, volume: 30, subtitles: true, silenceMs: 100, pronunciation: [{ word: "OMG", replacement: "oh my game" }], output: { bitRate: 32000 } });
    const params = JSON.parse(String(request.mock.calls[0]![1]!.body)).req_params;
    expect(params.audio_params).toMatchObject({ loudness_rate: 30, enable_subtitle: true, bit_rate: 32000 });
    expect(JSON.parse(params.additions)).toMatchObject({ post_process: { pitch: -4 }, explicit_language: "en", enable_auto_language_recognition: true, explicit_dialect: "yue", silence_duration: 100, pronunciation_dict: { tone: ["OMG/oh my game"] }, disable_default_bit_rate: true });
    expect(generated.subtitles).toEqual({ text: "Hello", sentences: [{ text: "Hello", startMs: 20, endMs: 200, words: [{ text: "Hello", startMs: 20, endMs: 200, confidence: 0.9 }] }] });
    expect(generated.metadata?.usageCharacters).toBe(5);
  });
  it("selects the cloned voice resource and rejects incompatible voice instructions", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: MP3.toString("base64") })));
    const provider = new VolcengineTtsProvider(() => "key", request);
    await provider.generate({ operation: "speech", model: MODEL, text: "Hello", voiceId: "S_existing", voiceKind: "cloned", voiceModel: "expressive" });
    expect(request.mock.calls[0]![1]!.headers).toMatchObject({ "X-Api-Resource-Id": "seed-icl-2.0" });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).req_params.model).toBe("seed-tts-2.0-expressive");
    await expect(provider.generate({ operation: "speech", model: MODEL, text: "Hello", voiceId: "S_existing", voiceKind: "cloned", style: "whisper" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("checks dialects, voice instructions and SSML against the selected preset voice", async () => {
    const request = vi.fn<typeof fetch>();
    const provider = new VolcengineTtsProvider(() => "key", request);
    const speech = { operation: "speech", model: MODEL, text: "Hello" } as const;
    await expect(provider.generate({ ...speech, voiceId: "zh_female_sophie_uranus_bigtts", dialect: "sichuan" })).rejects.toThrow("does not support dialects");
    await expect(provider.generate({ ...speech, voiceId: "en_male_ryan_uranus_bigtts", style: "whisper" })).rejects.toThrow("does not follow voice instructions");
    await expect(provider.generate({ ...speech, voiceId: "ja_male_bv524_uranus_bigtts", ssml: "<speak>Hello</speak>" })).rejects.toThrow("Chinese and English voices");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects non-audio and noncanonical Base64, even when the stream claims success", async () => {
    for (const data of [Buffer.from("not-audio").toString("base64"), "SGVsbG8=$garbage", "@@@@"]) {
      const provider = new VolcengineTtsProvider(() => "key", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, data }))));
      await expect(provider.generate({ operation: "speech", text: "Hello", voiceId: "voice", model: MODEL })).rejects.toMatchObject({ statusCode: 502 });
    }
  });
  it("handles JSON split across arbitrary network chunks and releases failed readers", async () => {
    const raw = JSON.stringify({ code: 0, data: MP3.toString("base64") }) + "\n" + JSON.stringify({ code: 20000000 });
    const bytes = new TextEncoder().encode(raw);
    const provider = new VolcengineTtsProvider(() => "key", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); } }))));
    await expect(provider.generate({ operation: "speech", text: "Hello", voiceId: "voice", model: MODEL })).resolves.toMatchObject({ bytes: MP3 });
    const cancel = vi.fn();
    const invalid = new VolcengineTtsProvider(() => "key", vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("invalid\n")); }, cancel }))));
    await expect(invalid.generate({ operation: "speech", text: "Hello", voiceId: "voice", model: MODEL })).rejects.toMatchObject({ statusCode: 502 });
    expect(cancel).toHaveBeenCalled();
  });
});
