import { afterEach, describe, expect, it, vi } from "vitest";
import { GptSovitsProvider, gsvVoiceId } from "../src/daemon/gpt-sovits-provider.js";

import { wavFixture } from "./audio-fixtures.js";
const WAV = wavFixture(1, 48_000);

const BASE = "http://192.0.2.10:9880";
const MODEL = { provider: "gpt-sovits", id: "gpt-sovits" } as const;
const REF_FILE = "/voice-packs/narrator/refs/chinese/calm.wav";
const VOICE_ID = gsvVoiceId("narrator", REF_FILE);

const VOICES_BODY = JSON.stringify({
  count: 2,
  voices: [
    { voice: "backup", refs: [], tags: ["no reference audio"] },
    {
      voice: "narrator",
      refs: [{ file: REF_FILE, emotion: "calm", prompt_text: "今天的天气很好。" }],
    },
  ],
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GPT-SoVITS provider", () => {
  it("runs the async task flow end to end with the gateway contract", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ task_id: "task-1" })))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ status: "queued" })))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ status: "running" })))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ status: "done" })))
      .mockImplementationOnce(async () => Promise.resolve(new Response(new Uint8Array(WAV), { status: 200, headers: { "content-type": "audio/wav" } })));
    const provider = new GptSovitsProvider(() => BASE, () => "gateway-token", request);

    const pending = provider.generate({
      operation: "speech",
      model: MODEL,
      text: "你好，旅行者。",
      voiceId: VOICE_ID,
      speed: 10,
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    const result = await pending;

    expect(result.mediaType).toBe("audio/wav");
    expect(result.bytes).toEqual(new Uint8Array(WAV));
    expect(result.model).toEqual(MODEL);

    const [voicesUrl] = request.mock.calls[0];
    expect(String(voicesUrl)).toBe(`${BASE}/voices`);
    const [submitUrl, submitInit] = request.mock.calls[1];
    const submitted = new URL(String(submitUrl));
    expect(`${submitted.origin}${submitted.pathname}`).toBe(`${BASE}/tts/async`);
    expect(submitInit?.method).toBe("POST");
    expect(submitInit?.headers).toEqual({ "X-GSV-Token": "gateway-token" });
    expect(submitInit?.body).toBeUndefined();
    expect(Object.fromEntries(submitted.searchParams)).toEqual({
      text: "你好，旅行者。",
      text_lang: "zh",
      ref_audio_path: REF_FILE,
      prompt_text: "今天的天气很好。",
      prompt_lang: "zh",
      speed_factor: "1.1",
      media_type: "wav",
    });
    expect(String(request.mock.calls[2][0])).toBe(`${BASE}/task/task-1`);
    expect(String(request.mock.calls[5][0])).toBe(`${BASE}/task/task-1/audio`);
  });

  it("falls back to the first available voice and the prompt language", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>();
    request
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ task_id: "task-2" })))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ status: "done" })))
      .mockImplementationOnce(async () => Promise.resolve(new Response(new Uint8Array(WAV), { status: 200 })));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);

    const pending = provider.generate({ operation: "speech", model: MODEL, text: "Hello." });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;

    const [submitUrl, submitInit] = request.mock.calls[1];
    const submitted = new URL(String(submitUrl));
    expect(submitted.searchParams.get("ref_audio_path")).toBe(REF_FILE);
    expect(submitted.searchParams.get("text_lang")).toBe("zh");
    expect(submitted.searchParams.get("media_type")).toBe("wav");
    expect(submitted.searchParams.has("speed_factor")).toBe(false);
    expect("X-GSV-Token" in (submitInit?.headers ?? {})).toBe(false);
  });

  it("maps gateway auth failures to a token hint", async () => {
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401)));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);

    await expect(provider.generate({ operation: "speech", model: MODEL, text: "你好。" }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("token") });
  });

  it("reports failed tasks with the gateway error", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ task_id: "task-3" })))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ status: "error", error: "backend exploded" })));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);

    const pending = provider.generate({ operation: "speech", model: MODEL, text: "你好。" });
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("backend exploded") });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it("rejects speech text beyond the model limit", async () => {
    const provider = new GptSovitsProvider(() => BASE, () => undefined, vi.fn<typeof fetch>());
    await expect(provider.generate({ operation: "speech", model: MODEL, text: "长".repeat(501) }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it("requires a usable voice pack", async () => {
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ voices: [{ voice: "女声", refs: [] }] })));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);
    await expect(provider.generate({ operation: "speech", model: MODEL, text: "你好。" }))
      .rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("voice packs") });
  });

  it("lists voices with precomputed stable ids and availability", async () => {
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);

    const voices = await provider.voices();
    expect(voices).toEqual([
      { id: "", label: "backup", voice: "backup", emotion: "", available: false },
      {
        id: VOICE_ID,
        label: "narrator · calm",
        voice: "narrator",
        emotion: "calm",
        refAudioPath: REF_FILE,
        promptText: "今天的天气很好。",
        promptLang: "zh",
        available: true,
      },
    ]);
    expect(VOICE_ID).toMatch(/^gsv-[a-f0-9]{10}$/);
  });

  it("aborts polling when the caller cancels", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ task_id: "task-abort" })))
      .mockImplementation(async () => Promise.resolve(jsonResponse({ status: "running" })));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);
    const controller = new AbortController();

    const pending = provider.generate({ operation: "speech", model: MODEL, text: "你好。" }, controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
  });

  it("times out once the synthesis budget is exhausted", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse(JSON.parse(VOICES_BODY))))
      .mockImplementationOnce(async () => Promise.resolve(jsonResponse({ task_id: "task-slow" })))
      .mockImplementation(async () => Promise.resolve(jsonResponse({ status: "running" })));
    const provider = new GptSovitsProvider(() => BASE, () => undefined, request);

    // Three characters of text buy a 120s + 3×(60/4.5)s ≈ 160s synthesis budget.
    const pending = provider.generate({ operation: "speech", model: MODEL, text: "你好。" });
    const assertion = expect(pending).rejects.toMatchObject({ statusCode: 504, message: expect.stringContaining("timed out") });
    for (let tick = 0; tick < 60; tick += 1) await vi.advanceTimersByTimeAsync(4_000);
    await assertion;
  });

  it("rejects non-speech operations and unknown models", async () => {
    const provider = new GptSovitsProvider(() => BASE, () => undefined, vi.fn<typeof fetch>());
    await expect(provider.generate({ operation: "music", prompt: "bossa nova", instrumental: true } as never))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
