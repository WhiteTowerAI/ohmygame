import { describe, expect, it, vi } from "vitest";
import { ElevenLabsAudioProvider, languageCode, speechSpeed } from "../src/daemon/elevenlabs-audio-provider.js";
import { mp3Fixture } from "./audio-fixtures.js";

const MP3 = new Uint8Array(mp3Fixture(48000));
const speech = { provider: "elevenlabs", id: "eleven_v4" } as const;
const MODELS = [
  { model_id: "eleven_v4", name: "Eleven v4", can_do_text_to_speech: true, maximum_text_length_per_request: 10_000 },
  { model_id: "eleven_text_to_sound_v3", name: "Eleven Sound Effects v3" },
  { model_id: "music_v2_5", name: "Eleven Music v2.5" },
  { model_id: "scribe_v2", name: "Scribe v2" },
];
const OPENAPI = { components: { schemas: { SFXModelId: { enum: ["eleven_text_to_sound_v2", "eleven_text_to_sound_v3"] }, MusicModelID: { enum: ["music_v2_5"] } } } };

function provider(response: Response, loadModels = true) {
  const request = vi.fn<typeof fetch>();
  if (loadModels) request.mockResolvedValueOnce(Response.json(MODELS)).mockResolvedValueOnce(Response.json(OPENAPI));
  request.mockResolvedValue(response);
  return { request, adapter: new ElevenLabsAudioProvider(() => "eleven-key", request) };
}

function sent(request: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = request.mock.calls.at(-1)!;
  return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
}

describe("ElevenLabs audio provider", () => {
  it("does not expose retired sound-effect models and retries a failed catalog lookup", async () => {
    let fail = true;
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/v1/models")) {
        if (fail) { fail = false; throw new Error("offline"); }
        return Response.json(MODELS);
      }
      return Response.json(OPENAPI);
    });
    const adapter = new ElevenLabsAudioProvider(() => "eleven-key", request);

    await expect(adapter.models()).rejects.toMatchObject({ statusCode: 502 });
    await expect(adapter.models()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "eleven_text_to_sound_v3" }),
    ]));
    expect((await adapter.models()).some((model) => model.id === "eleven_text_to_sound_v2")).toBe(false);
  });

  it("sends speech to the voice's text-to-speech endpoint with mapped settings", async () => {
    const { request, adapter } = provider(new Response(MP3, { headers: { "request-id": "req-1" } }));
    await expect(adapter.generate({ model: speech, prompt: "  Hello there  ", voiceId: "voice/1", language: "zh-cn", speed: 50 })).resolves.toMatchObject({
      mediaType: "audio/mpeg",
      model: speech,
      metadata: { providerRequestId: "req-1" },
    });
    const { url, init, headers } = sent(request);
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_128");
    expect(headers["xi-api-key"]).toBe("eleven-key");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Hello there", model_id: "eleven_v4", language_code: "zh", voice_settings: { speed: 1.2 } });
  });

  it("requires a voice for speech", async () => {
    const { request, adapter } = provider(new Response(MP3));
    await expect(adapter.generate({ model: speech, prompt: "Hello" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("routes sound-effect and music models to their own endpoints within the model's duration", async () => {
    const effect = provider(new Response(MP3));
    await effect.adapter.generate({ model: { provider: "elevenlabs", id: "eleven_text_to_sound_v3" }, prompt: "Door slam", durationSeconds: 2, loop: true });
    expect(sent(effect.request).url).toContain("/v1/sound-generation?");
    expect(JSON.parse(String(sent(effect.request).init.body))).toEqual({ text: "Door slam", model_id: "eleven_text_to_sound_v3", duration_seconds: 2, loop: true });
    await expect(effect.adapter.generate({ model: { provider: "elevenlabs", id: "eleven_text_to_sound_v3" }, prompt: "Door", durationSeconds: 31 })).rejects.toMatchObject({ statusCode: 400 });

    const music = provider(new Response(MP3));
    await music.adapter.generate({ model: { provider: "elevenlabs", id: "music_v2_5" }, prompt: "Calm harp", instrumental: true, durationSeconds: 12.5 });
    expect(sent(music.request).url).toContain("/v1/music?");
    expect(JSON.parse(String(sent(music.request).init.body))).toEqual({ prompt: "Calm harp", model_id: "music_v2_5", force_instrumental: true, music_length_ms: 12_500 });
    const vocal = provider(new Response(MP3));
    await vocal.adapter.generate({ model: { provider: "elevenlabs", id: "music_v2_5" }, prompt: "Song" });
    expect(JSON.parse(String(sent(vocal.request).init.body))).toEqual({ prompt: "Song", model_id: "music_v2_5" });
  });

  it("lists account voices a page at a time and keeps only https samples", async () => {
    const { request, adapter } = provider(Response.json({
      voices: [
        { voice_id: "a", name: "Aria", preview_url: "https://cdn.example/a.mp3", labels: { accent: "british", age: 3 } },
        { voice_id: "b", name: "Bram", preview_url: "http://cdn.example/b.mp3" },
        { voice_id: 7, name: "broken" },
      ],
      has_more: true,
      next_page_token: "page-2",
    }), false);
    await expect(adapter.voices({ search: " ar ", pageToken: "page-1" })).resolves.toEqual({
      voices: [
        { id: "a", name: "Aria", previewUrl: "https://cdn.example/a.mp3", labels: { accent: "british" } },
        { id: "b", name: "Bram" },
      ],
      nextPageToken: "page-2",
    });
    const url = new URL(sent(request).url);
    expect(url.pathname).toBe("/v2/voices");
    expect(Object.fromEntries(url.searchParams)).toEqual({ page_size: "100", include_total_count: "false", search: "ar", next_page_token: "page-1" });
  });

  it("transcribes audio with Scribe as multipart form data", async () => {
    const { request, adapter } = provider(Response.json({ text: " Hello world ", language_code: "en" }));
    await expect(adapter.transcribe({ bytes: MP3, mediaType: "audio/mpeg", name: "line.mp3", language: "en-US", model: { provider: "elevenlabs", id: "scribe_v2" } }))
      .resolves.toEqual({ text: "Hello world", language: "en", model: { provider: "elevenlabs", id: "scribe_v2" } });
    const { url, init } = sent(request);
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    expect((form.get("file") as File).name).toBe("line.mp3");
  });

  it("maps provider errors to OhMyGame status codes", async () => {
    for (const [status, detail, expected] of [
      [401, { status: "invalid_api_key", message: "Invalid API key" }, 503],
      [429, "Too many requests", 429],
      [422, [{ msg: "text is required" }], 400],
      [500, "boom", 502],
    ] as const) {
      const { adapter } = provider(Response.json({ detail }, { status }));
      await expect(adapter.generate({ model: speech, prompt: "Hi", voiceId: "a" })).rejects.toMatchObject({ statusCode: expected });
    }
    const { adapter } = provider(Response.json({ detail: "Invalid API key" }, { status: 401 }), false);
    await expect(adapter.voices({})).rejects.toThrow("ElevenLabs: Invalid API key");
  });

  it("asks to connect first without a key", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new ElevenLabsAudioProvider(() => undefined, request).voices({})).rejects.toMatchObject({ statusCode: 503 });
    expect(request).not.toHaveBeenCalled();
  });

  it("maps shared language and speed values", () => {
    expect(languageCode("zh-cn")).toBe("zh");
    expect(languageCode("yue")).toBe("yue");
    expect(languageCode("")).toBeUndefined();
    expect(speechSpeed(-50)).toBe(0.7);
    expect(speechSpeed(10)).toBe(1.1);
    expect(speechSpeed(100)).toBe(1.2);
  });
});
