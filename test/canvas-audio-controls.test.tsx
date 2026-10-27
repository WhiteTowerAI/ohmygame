// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CanvasAudioControls,
  audioSettingsIssue,
} from "../src/renderer/canvas-audio-controls.js";
import { VOLCENGINE_SEED_AUDIO_MODELS } from "../src/daemon/volcengine-seed-audio-provider.js";
import { VOLCENGINE_TTS_MODELS } from "../src/daemon/volcengine-tts-provider.js";
import { encodeAudioClip } from "../src/renderer/audio-clip.js";
import {
  audioSubtitleFile,
  resolveAudioMentions,
  type AudioCanvasSettings,
} from "../src/shared/audio.js";

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

it("offers format-specific rates and persists the subtitle and voice controls", async () => {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState<AudioCanvasSettings>({});
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
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  expect(changed).toHaveBeenLastCalledWith({ subtitles: true });
});

it("reveals custom and cloned voice controls without losing saved synthesis settings", async () => {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState<AudioCanvasSettings>({
      voiceId: "zh_female_vv_uranus_bigtts",
      pitch: -2,
      subtitles: true,
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
  expect(label("Subtitles")?.querySelector("input")?.checked).toBe(true);
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

it("keeps reference actions accessible and disables moves past the list boundaries", async () => {
  const move = vi.fn(),
    remove = vi.fn();
  await act(async () =>
    root.render(
      <CanvasAudioControls
        value={{}}
        model={VOLCENGINE_SEED_AUDIO_MODELS[0]}
        onChange={vi.fn()}
        referenceControls={{
          choices: [],
          references: [
            {
              id: "Audio1",
              name: "Rain",
              type: "audio",
              source: { type: "library", assetId: "rain" },
            },
            {
              id: "Audio2",
              name: "Wind",
              type: "audio",
              source: { type: "library", assetId: "wind" },
            },
          ],
          move,
          remove,
          read: vi.fn(),
          upload: vi.fn(),
          replace: vi.fn(),
          add: vi.fn(),
        }}
      />,
    ),
  );
  const rain = host.querySelector('[aria-label="@Audio1 · Rain"]')!,
    wind = host.querySelector('[aria-label="@Audio2 · Wind"]')!;
  const button = (group: Element, name: string) =>
    group.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
  expect(button(rain, "Move reference earlier").disabled).toBe(true);
  expect(button(wind, "Move reference later").disabled).toBe(true);
  await act(async () => button(rain, "Move reference later").click());
  expect(move).toHaveBeenCalledWith("Audio1", 1);
  await act(async () => button(wind, "Remove reference").click());
  expect(remove).toHaveBeenCalledWith("Audio2");
});

it("blocks mixed modes and resolves stable reference aliases after reordering", () => {
  const model = VOLCENGINE_SEED_AUDIO_MODELS[0]!;
  expect(
    audioSettingsIssue(
      {
        voiceId: "voice",
        audioReferences: [
          {
            id: "Image1",
            type: "image",
            source: { type: "library", assetId: "portrait" },
          },
        ],
      },
      model,
    ),
  ).toBeTruthy();
  const audio = (id: string) => ({
    id,
    type: "audio" as const,
    source: { type: "library" as const, assetId: id },
  });
  // A Speaker ID takes one of the three audio slots.
  expect(
    audioSettingsIssue(
      { voiceId: "voice", audioReferences: [audio("Audio1"), audio("Audio2")] },
      model,
    ),
  ).toBeUndefined();
  expect(
    audioSettingsIssue(
      {
        voiceId: "voice",
        audioReferences: [audio("Audio1"), audio("Audio2"), audio("Audio3")],
      },
      model,
    ),
  ).toBeTruthy();
  expect(
    resolveAudioMentions("@Audio1 then @Audio2", [
      { id: "Audio2", type: "audio" },
      { id: "Audio1", type: "audio" },
    ]),
  ).toBe("@音频2 then @音频1");
  expect(() =>
    resolveAudioMentions("@Audio1", [{ id: "Audio2", type: "audio" }]),
  ).toThrow("missing reference");
});

it("encodes an actual source clip and exports correct subtitle timestamps", async () => {
  const blob = encodeAudioClip([new Float32Array(48000)], 48000, 0.1, 0.5);
  const bytes = new DataView(await blob.arrayBuffer());
  expect(bytes.getUint32(24, true)).toBe(48000);
  expect(bytes.getUint32(40, true)).toBe(38400);
  expect(() =>
    encodeAudioClip([new Float32Array(48000 * 40)], 48000, 0, 31),
  ).toThrow();
  const subtitles = {
    text: "Hello",
    sentences: [{ text: "Hello", startMs: 125, endMs: 1200 }],
  };
  expect(audioSubtitleFile(subtitles, "srt")).toContain(
    "00:00:00,125 --> 00:00:01,200",
  );
  expect(audioSubtitleFile(subtitles, "vtt")).toMatch(
    /^WEBVTT\n\n00:00:00.125 --> 00:00:01.200/,
  );
});
