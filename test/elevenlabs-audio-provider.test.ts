import { describe, expect, it, vi } from "vitest";
import { ElevenLabsAudioProvider, languageCode, speechSpeed } from "../src/daemon/elevenlabs-audio-provider.js";
import { mp3Fixture } from "./audio-fixtures.js";

const MP3 = new Uint8Array(mp3Fixture(48000));
const speech = { provider: "elevenlabs", id: "eleven_v4" } as const;

function provider(response: Response) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { request, adapter: new ElevenLabsAudioProvider(() => "eleven-key", request) };
}

function sent(request: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = request.mock.calls[0]!;
  return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
}

describe("ElevenLabs audio provider", () => {
  it("sends speech to the voice's text-to-speech endpoint with mapped settings", async () => {
    const { request, adapter } = provider(new Response(MP3, { headers: { "request-id": "req-1" } }));
    await expect(adapter.generate({ operation: "speech", model: speech, text: "  Hello there  ", voiceId: "voice/1", language: "zh-cn", speed: 50 })).resolves.toMatchObject({
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
    await expect(adapter.generate({ operation: "speech", model: speech, text: "Hello" })).rejects.toMatchObject({ statusCode: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends sound effects and music to their own endpoints within the model's duration", async () => {
    const effect = provider(new Response(MP3));
    await effect.adapter.generate({ operation: "sound-effect", model: { provider: "elevenlabs", id: "eleven_text_to_sound_v2" }, prompt: "Door slam", durationSeconds: 2, loop: true });
    expect(sent(effect.request).url).toContain("/v1/sound-generation?");
    expect(JSON.parse(String(sent(effect.request).init.body))).toEqual({ text: "Door slam", model_id: "eleven_text_to_sound_v2", duration_seconds: 2, loop: true });
    await expect(effect.adapter.generate({ operation: "sound-effect", model: { provider: "elevenlabs", id: "eleven_text_to_sound_v2" }, prompt: "Door", durationSeconds: 31 })).rejects.toMatchObject({ statusCode: 400 });

    const music = provider(new Response(MP3));
    await music.adapter.generate({ operation: "music", model: { provider: "elevenlabs", id: "music_v1" }, prompt: "Calm harp", instrumental: true, durationSeconds: 12.5 });
    expect(sent(music.request).url).toContain("/v1/music?");
    expect(JSON.parse(String(sent(music.request).init.body))).toEqual({ prompt: "Calm harp", model_id: "music_v1", force_instrumental: true, music_length_ms: 12_500 });
    await expect(music.adapter.generate({ operation: "music", model: { provider: "elevenlabs", id: "music_v1" }, prompt: "Song", instrumental: false, lyrics: "la la" })).rejects.toMatchObject({ statusCode: 400 });
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
    }));
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
      await expect(adapter.generate({ operation: "speech", model: speech, text: "Hi", voiceId: "a" })).rejects.toMatchObject({ statusCode: expected });
    }
    const { adapter } = provider(Response.json({ detail: "Invalid API key" }, { status: 401 }));
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
