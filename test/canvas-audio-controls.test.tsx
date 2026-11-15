// @vitest-environment happy-dom
import { ReactFlowProvider } from "@xyflow/react";
import { AudioNode } from "../src/renderer/asset-canvas-nodes.js";
import type { AssetCanvasFlowData } from "../src/renderer/asset-canvas-flow.js";
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

const elevenSpeech: AudioModel = { provider: "elevenlabs", providerName: "ElevenLabs", id: "eleven_flash_v2_5", name: "Eleven Flash v2.5", protocol: "elevenlabs-v1", capabilities: { formats: ["mp3"], sampleRatesByFormat: { mp3: [44_100] }, produces: ["speech"], readsText: true, requiresVoice: true, supportsSpeaker: true, speedRange: [-30, 20] } };
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
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ voices: [{ id: "aria", name: "Aria" }], nextPageToken: "next" }));
  vi.stubGlobal("fetch", fetch);
  await act(async () => root.render(<CanvasAudioControls value={{ voiceId: "saved" }} model={elevenSpeech} listsVoices onChange={vi.fn()} />));
  await vi.waitFor(() => expect(Array.from(host.querySelectorAll("select")[0]!.options).map((option) => option.value)).toEqual(["", "saved", "aria"]));
  expect(String(fetch.mock.calls[0]![0])).toContain("/audio-providers/elevenlabs/voices");
  const speed = host.querySelector<HTMLInputElement>(".audio-control-adjustments input")!;
  expect([speed.min, speed.max]).toEqual(["-30", "20"]);
  await act(async () => root.render(<CanvasAudioControls value={{ voiceId: "saved" }} model={elevenSpeech} listsVoices quick inline onChange={vi.fn()} />));
  expect(host.querySelector('input[type="search"]')).not.toBeNull();
  await vi.waitFor(() => expect(host.querySelector(".audio-provider-voices > button")).not.toBeNull());

  await act(async () => root.render(<CanvasAudioControls value={{}} model={elevenEffect} onChange={vi.fn()} />));
  expect(host.querySelector(".audio-control-adjustments input")).toBeNull();
  expect(Array.from(host.querySelectorAll("label")).some((label) => label.textContent?.startsWith("Language"))).toBe(false);
});

it("ignores an older voice page after switching providers and preserves the saved choice", async () => {
  let finish!: (response: Response) => void;
  const later = new Promise<Response>(resolve => { finish = resolve; });
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
    const address = String(url);
    if (address.includes("pageToken=")) return later;
    return Response.json({ voices: [{ id: address.includes("other") ? "new" : "first", name: "Voice" }], nextPageToken: "next" });
  });
  vi.stubGlobal("fetch", fetch);
  const change = vi.fn();
  await act(async () => root.render(<CanvasAudioControls value={{ voiceId: "saved" }} model={elevenSpeech} listsVoices onChange={change} />));
  const options = () => Array.from(host.querySelectorAll("select")[0]!.options).map(option => option.value);
  await vi.waitFor(() => expect(options()).toContain("first"));
  const more = host.querySelector<HTMLButtonElement>(".audio-provider-voices > button")!;
  expect(more).toBeDefined();
  await act(async () => more.click());
  expect(host.querySelectorAll("select")[0]!.disabled).toBe(true);
  await act(async () => root.render(<CanvasAudioControls value={{ voiceId: "saved" }} model={{ ...elevenSpeech, provider: "plugin.other.audio" }} listsVoices onChange={change} />));
  await vi.waitFor(() => expect(options()).toContain("new"));
  await act(async () => { finish(Response.json({ voices: [{ id: "old-page", name: "Old page" }] })); await later; });
  expect(options()).toEqual(["", "saved", "new"]);
  expect(change).not.toHaveBeenCalled();
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


it("hides fixed-speed controls and retains the saved speed when switching back", async () => {
  const changed = vi.fn();
  const saved = Object.freeze({ speed: 20 });
  const fixed = { ...elevenSpeech, id: "eleven_v4", capabilities: { ...elevenSpeech.capabilities, speedRange: [0, 0] as const } };
  const quick = (model: AudioModel) => <CanvasAudioQuickControls value={saved} model={model} onChange={changed} />;
  await act(async () => root.render(quick(elevenSpeech)));
  expect(host.querySelector(".audio-quick-speed")?.textContent).toBe("1.2×");
  await act(async () => root.render(quick(fixed)));
  expect(host.querySelector(".audio-quick-speed")).toBeNull();
  await act(async () => root.render(quick(elevenSpeech)));
  expect(host.querySelector(".audio-quick-speed")?.textContent).toBe("1.2×");
  await act(async () => root.render(<CanvasAudioControls value={saved} model={fixed} onChange={changed} />));
  expect(host.querySelector(".audio-control-adjustments input")).toBeNull();
  await act(async () => root.render(<CanvasAudioControls value={saved} model={elevenSpeech} onChange={changed} />));
  expect(host.querySelector<HTMLInputElement>(".audio-control-adjustments input")?.value).toBe("20");
  expect(saved.speed).toBe(20);
  expect(changed).not.toHaveBeenCalled();
});

const musicModel: AudioModel = { ...elevenEffect, id: "music", name: "Music", capabilities: { produces: ["music"], formats: ["mp3"], maxDurationSeconds: 90 } };
const otherSpeech: AudioModel = { ...elevenSpeech, provider: "other", id: "tts", name: "Other speech" };
async function renderAudio(initial: AssetCanvasFlowData, defaults = { music: { provider: musicModel.provider, id: musicModel.id }, speech: { provider: otherSpeech.provider, id: otherSpeech.id } }, busy = false) {
  const changed = vi.fn();
  function Harness() {
    const [data, setData] = useState(initial);
    return <ReactFlowProvider><AudioNode selected data={{ ...data, panelOpen: true, audioRuntime: {
      models: [elevenEffect, elevenSpeech, musicModel, otherSpeech], providers: [], defaultModels: defaults,
      busy, generating: false, onGenerate: vi.fn(), onChange: (next) => { changed(next); setData(next); },
    } }} /></ReactFlowProvider>;
  }
  await act(async () => root.render(<Harness />));
  return changed;
}
async function pickAudio(label: string, option: string) {
  const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}:"]`)!;
  expect(trigger).not.toBeNull();
  await act(async () => trigger.click());
  const choice = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((node) => node.textContent?.includes(option));
  expect(choice).toBeDefined();
  await act(async () => choice!.click());
}
it("switches purpose using its default, filters choices and keeps the prompt", async () => {
  const changed = await renderAudio({ prompt: "Keep these words", audioKind: "speech", audioModel: elevenSpeech, voiceId: "my-voice" });
  await pickAudio("Audio purpose", "Music");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ audioKind: "music", audioModel: { provider: musicModel.provider, id: musicModel.id }, prompt: "Keep these words", voiceId: undefined }));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="Audio model:"]')!.click());
  expect(Array.from(document.querySelectorAll('[role="option"]')).map((node) => node.textContent)).toEqual([expect.stringContaining("Music")]);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await pickAudio("Audio purpose", "Speech");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ audioModel: { provider: "other", id: "tts" }, audioKind: "speech" }));
});
it("keeps a compatible manual choice through free-form and purpose changes", async () => {
  const changed = await renderAudio({ prompt: "Hello", audioModel: elevenSpeech, voiceId: "my-voice" });
  expect(host.querySelector('button[aria-label="Audio purpose: Free-form audio"]')).not.toBeNull();
  await pickAudio("Audio purpose", "Speech");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ audioModel: elevenSpeech, voiceId: "my-voice" }));
  await pickAudio("Audio purpose", "Free-form audio");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ audioKind: undefined, audioModel: elevenSpeech, voiceId: "my-voice" }));
});
it("keeps an unavailable purpose default and does not enable generation with another model", async () => {
  const changed = await renderAudio({ prompt: "music", audioKind: "speech", audioModel: elevenSpeech }, { music: { provider: "disconnected", id: "music" }, speech: elevenSpeech });
  await pickAudio("Audio purpose", "Music");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ audioModel: { provider: "disconnected", id: "music" } }));
  expect(host.querySelector('button[aria-label^="Audio model:"]')?.textContent).toContain("Unavailable");
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="Generate audio"]')?.disabled).toBe(true);
});
it("locks purpose and model while a generation is running", async () => {
  await renderAudio({ prompt: "Hello", audioKind: "speech", audioModel: elevenSpeech }, undefined, true);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Audio purpose:"]')!.disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('button[aria-label^="Audio model:"]')!.disabled).toBe(true);
});

it("clears account-specific voice IDs even when both providers use the same protocol", async () => {
  const changed = await renderAudio({ prompt: "Hello", audioKind: "speech", audioModel: elevenSpeech, voiceId: "private-voice" });
  await pickAudio("Audio model", "Other speech");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ audioModel: { provider: "other", id: "tts" }, voiceId: undefined }));
});
