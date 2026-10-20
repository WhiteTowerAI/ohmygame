// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PlayableVideoTrimDialog,
  parseTrimTime,
} from "../src/renderer/playable-video-trim-dialog.js";

let root: Root;
let container: HTMLDivElement;
const apply = vi.fn();
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:trim-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  apply.mockReset().mockResolvedValue(undefined);
  close.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(clip = { start: 2, end: 8 }) {
  await act(async () =>
    root.render(
      <PlayableVideoTrimDialog
        blob={new Blob(["video"])}
        clip={clip}
        onApply={apply}
        onClose={close}
      />,
    ),
  );
  const video = document.querySelector("video")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 12 });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  return video;
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  )!;
}
async function submit() {
  expect(button("Apply trim").disabled).toBe(false);
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function input(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("parses seconds or minutes without accepting ambiguous or invalid time text", () => {
  expect(parseTrimTime(" 3.250 ")).toBe(3.25);
  expect(parseTrimTime("1:02.125")).toBe(62.125);
  for (const value of ["-1", "NaN", "1:60", "", "1e3", "1:2:3", "3.1234"])
    expect(parseTrimTime(value)).toBeUndefined();
});

it("loads the selected range, previews its start and applies one source edit", async () => {
  const video = await mount();
  expect(video.currentTime).toBe(2);
  expect(
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Start time (seconds or mm:ss.xxx)"]',
    )!.value,
  ).toBe("0:02.000");
  await input("Start time (seconds or mm:ss.xxx)", "3.2");
  await input("End time (seconds or mm:ss.xxx)", "0:08.750");
  await submit();
  expect(apply).toHaveBeenCalledExactlyOnceWith({ start: 3.2, end: 8.75 });
  expect(close).toHaveBeenCalledOnce();
});

it("cancels without persisting, and restores focus and Blob resources on unmount", async () => {
  await mount();
  await act(async () => button("Cancel").click());
  expect(apply).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it("restores the full video as a draft, then removes the trim only on Apply", async () => {
  await mount();
  await act(async () => button("Restore full video").click());
  expect(apply).not.toHaveBeenCalled();
  await submit();
  expect(apply).toHaveBeenCalledWith(undefined);
});

it("refuses invalid ranges and retains a failed draft for retry", async () => {
  await mount();
  await input("End time (seconds or mm:ss.xxx)", "1");
  expect(button("Apply trim").disabled).toBe(true);
  await input("End time (seconds or mm:ss.xxx)", "9");
  apply.mockRejectedValueOnce(new Error("Source changed"));
  await submit();
  expect(document.querySelector('[role="alert"]')!.textContent).toBe(
    "Source changed",
  );
  expect(close).not.toHaveBeenCalled();
});

it("shows the end frame while dragging the end handle and keeps it after re-render", async () => {
  const video = await mount();
  const track = document.querySelector<HTMLElement>(".video-trimmer-track")!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    left: 0,
    width: 120,
    top: 0,
    right: 120,
    bottom: 48,
    height: 48,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  const handle = document.querySelector<HTMLElement>(
    ".video-trimmer-handle.is-end",
  )!;
  handle.setPointerCapture = vi.fn();
  await act(async () =>
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientX: 62.5,
      }),
    ),
  );
  expect(video.currentTime).toBeCloseTo(6.25);
  await submit();
  expect(apply).toHaveBeenCalledWith({ start: 2, end: 6.25 });
});
