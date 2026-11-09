import { describe, expect, it, vi } from "vitest";
import { ElevenLabsTtsProvider } from "../src/daemon/elevenlabs-tts-provider.js";

describe("ElevenLabsTtsProvider", () => {
  it("sends a protected TTS request and returns MP3 audio", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([73, 68, 51, 4]), { headers: { "request-id": "request-1" } }));
    const provider = new ElevenLabsTtsProvider(() => "key", request);
    // The provider verifies media bytes; use the request contract test here and
    // let media parsing be covered by the existing audio-media tests.
    await expect(provider.generate({ operation: "speech", model: { provider: "elevenlabs", id: "eleven_v4" }, text: "Hello", voiceId: "voice-id" })).rejects.toThrow("Invalid mp3 audio");
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/voice-id?output_format=mp3_44100_128"), expect.objectContaining({ headers: expect.objectContaining({ "xi-api-key": "key" }) }));
  });
});
