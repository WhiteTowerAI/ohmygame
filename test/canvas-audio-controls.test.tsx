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
import {
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

it("offers format-specific rates without subtitles or reference inputs", async () => {
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
  expect(host.textContent).not.toContain("Subtitles");
  expect(host.querySelector('input[type="file"]')).toBeNull();
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

it("ignores legacy references and subtitles when checking current model options", () => {
  expect(audioSettingsIssue({ subtitles: true, audioReferences: [{ id: "Image1", type: "image", source: { type: "library", assetId: "portrait" } }], voiceId: "voice" }, VOLCENGINE_SEED_AUDIO_MODELS[0])).toBeUndefined();
  expect(audioSettingsIssue({ output: { format: "mp3", sampleRate: 40000 } }, VOLCENGINE_SEED_AUDIO_MODELS[0])).toBeTruthy();
  expect(audioSettingsIssue({ ssml: "<speak>Hello</speak>" }, VOLCENGINE_SEED_AUDIO_MODELS[0])).toBeTruthy();
});
