// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CanvasAudioControls,
  CanvasAudioQuickControls,
  audioSettingsIssue,
} from "../src/renderer/canvas-audio-controls.js";
import { VoiceSample } from "../src/renderer/doubao-voices.js";
import { VOLCENGINE_SEED_AUDIO_MODELS } from "../src/daemon/volcengine-seed-audio-provider.js";
import { VOLCENGINE_TTS_MODELS } from "../src/daemon/volcengine-tts-provider.js";
import type { AudioModel, AudioSettings } from "../src/shared/audio.js";

const elevenSpeech: AudioModel = { provider: "elevenlabs", providerName: "ElevenLabs", id: "eleven_v4", name: "Eleven v4", protocol: "elevenlabs-v1", capabilities: { formats: ["mp3"], sampleRatesByFormat: { mp3: [44_100] }, produces: ["speech"], readsText: true, requiresVoice: true, supportsSpeaker: true, speedRange: [-30, 20] } };
const elevenEffect: AudioModel = { provider: "elevenlabs", providerName: "ElevenLabs", id: "eleven_text_to_sound_v3", name: "Eleven Sound Effects v3", protocol: "elevenlabs-v1", capabilities: { formats: ["mp3"], sampleRatesByFormat: { mp3: [44_100] }, produces: ["sound-effect"] } };

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers format-specific rates without subtitles or reference inputs", async () => {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState<AudioSettings>({});
    return (
      <CanvasAudioControls
        value={value}
        model={VOLCENGINE_SEED_AUDIO_MODELS[0]}
        onChange={(patch) => {
          changed(patch);
          setValue((value) => ({ ...value, ...patch }));
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const select = (text: string) =>
    Array.from(host.querySelectorAll("label"))
      .find((label) => label.textContent?.startsWith(text))!
      .querySelector("select")!;
  expect(
    Array.from(select("Sample rate").options).some(
      (option) => option.value === "40000",
    ),
  ).toBe(false);
  await act(async () => {
    const format = select("Output format");
    format.value = "wav";
    format.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(changed).toHaveBeenLastCalledWith({ output: { format: "wav" } });
  expect(
    Array.from(select("Sample rate").options).some(
      (option) => option.value === "40000",
    ),
  ).toBe(true);
  expect(host.textContent).not.toContain("Subtitles");
  expect(host.querySelector('input[type="file"]')).toBeNull();
});

it("reveals custom and cloned voice controls without losing saved synthesis settings", async () => {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState<AudioSettings>({
      voiceId: "zh_female_vv_uranus_bigtts",
      pitch: -2,
      pronunciation: [{ word: "NPC", replacement: "non-player character" }],
    });
    return (
      <CanvasAudioControls
        value={value}
        model={VOLCENGINE_TTS_MODELS[0]}
        onChange={(patch) => {
          changed(patch);
          setValue((value) => ({ ...value, ...patch }));
        }}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const label = (text: string) =>
    Array.from(host.querySelectorAll("label")).find((label) =>
      label.textContent?.startsWith(text),
    );
  expect(label("Speaker ID")).toBeUndefined();
  expect(
    host.querySelector(".audio-advanced-options")?.hasAttribute("open"),
  ).toBe(false);
  const voice = label("Voice")!.querySelector("select")!;
  await act(async () => {
    voice.value = "__cloned";
    voice.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(changed).toHaveBeenLastCalledWith({
    voiceId: undefined,
    voiceKind: "cloned",
    voiceModel: undefined,
  });
  expect(label("Speaker ID")?.querySelector("input")).toBeTruthy();
  expect(label("Cloned voice model")?.querySelector("select")).toBeTruthy();
  expect(label("Pitch")?.querySelector("input")?.value).toBe("-2");
  expect(label("Subtitles")).toBeUndefined();
  expect(label("Pronunciation")?.querySelector("textarea")?.value).toBe(
    "NPC/non-player character",
  );
  await act(async () => {
    voice.value = "zh_female_vv_uranus_bigtts";
    voice.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(label("Speaker ID")).toBeUndefined();
  expect(label("Cloned voice model")).toBeUndefined();
});

it("checks saved settings against the current model", () => {
  expect(audioSettingsIssue({ voiceId: "voice" }, VOLCENGINE_SEED_AUDIO_MODELS[0])).toBeUndefined();
  expect(audioSettingsIssue({ output: { format: "mp3", sampleRate: 40000 } }, VOLCENGINE_SEED_AUDIO_MODELS[0])).toBeTruthy();
  expect(audioSettingsIssue({ ssml: "<speak>Hello</speak>" }, VOLCENGINE_SEED_AUDIO_MODELS[0])).toBeTruthy();
});

it("lists account voices and limits speed for models that speak, and hides both for sound-only models", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ voices: [{ id: "aria", name: "Aria" }], nextPageToken: "next" }));
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<CanvasAudioControls value={{ voiceId: "saved" }} model={elevenSpeech} listsVoices onChange={vi.fn()} />));
  await vi.waitFor(() => expect(Array.from(host.querySelectorAll("select")[0]!.options).map((option) => option.value)).toEqual(["", "saved", "aria"]));
  expect(String(fetch.mock.calls[0]![0])).toContain("/audio-providers/elevenlabs/voices");
  const speed = host.querySelector<HTMLInputElement>(".audio-control-adjustments input")!;
  expect([speed.min, speed.max]).toEqual(["-30", "20"]);

  await act(async () => root.render(<CanvasAudioControls value={{}} model={elevenEffect} onChange={vi.fn()} />));
  expect(host.querySelector(".audio-control-adjustments input")).toBeNull();
  expect(Array.from(host.querySelectorAll("label")).some((label) => label.textContent?.startsWith("Language"))).toBe(false);
});

it("shows the quick voice and speed without their names, and closes the speed slider on a press elsewhere", async () => {
  await act(async () => root.render(<CanvasAudioQuickControls value={{ speed: 20 }} model={VOLCENGINE_SEED_AUDIO_MODELS[0]} onChange={vi.fn()} />));
  const voice = host.querySelector<HTMLElement>(".audio-quick-voice")!;
  expect(voice.querySelector(":scope > span")).toBeNull();
  expect(voice.title).toBe("Voice");
  const speed = host.querySelector<HTMLButtonElement>(".audio-quick-speed")!;
  expect(speed.textContent).toBe("1.2×");
  expect(speed.getAttribute("aria-label")).toBe("Speed 1.2×");

  await act(async () => speed.click());
  const popover = () => host.querySelector(".audio-quick-speed-popover");
  expect(popover()).not.toBeNull();
  await act(async () => popover()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(popover()).not.toBeNull();
  await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(popover()).toBeNull();

  await act(async () => speed.click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(popover()).toBeNull();
});

it("shows a voice sample loading until it plays, lets a press cancel it, and says when it fails", async () => {
  const plays: Array<{ resolve(): void; reject(cause: unknown): void }> = [];
  class FakeAudio {
    paused = true;
    currentTime = 0;
    onended: (() => void) | null = null;
    constructor(readonly src: string) {}
    play() {
      return new Promise<void>((resolve, reject) => plays.push({
        resolve: () => { this.paused = false; resolve(); },
        reject,
      }));
    }
    pause() { this.paused = true; }
  }
  vi.stubGlobal("Audio", FakeAudio);
  await act(async () => root.render(<VoiceSample url="https://cdn.example/aria.mp3" />));
  const button = () => host.querySelector("button")!;

  await act(async () => button().click());
  expect(button().dataset.state).toBe("loading");
  expect(button().getAttribute("aria-busy")).toBe("true");
  await act(async () => plays[0]!.resolve());
  expect(button().dataset.state).toBe("playing");
  await act(async () => button().click());
  expect(button().dataset.state).toBe("idle");

  // A press while it loads stops it, and the aborted start isn't a failure.
  await act(async () => button().click());
  await act(async () => button().click());
  await act(async () => plays[1]!.reject(new DOMException("aborted", "AbortError")));
  expect(button().dataset.state).toBe("idle");

  await act(async () => button().click());
  await act(async () => plays[2]!.reject(new DOMException("network", "NotSupportedError")));
  expect(button().dataset.state).toBe("failed");
  expect(button().title).toContain("Couldn't load the sample");
});
