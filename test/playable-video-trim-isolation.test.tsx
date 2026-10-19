// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const trimVideo = vi.fn();
const videoFilmstrip = vi.fn();
const uploadLibraryAsset = vi.fn();
vi.doMock(path.resolve("src/renderer/video-trim.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/video-trim.js")>()),
  trimVideo,
  videoFilmstrip,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  uploadLibraryAsset,
}));
const { PlayableVideoTrimDialog } =
  await import("../src/renderer/playable-video-trim-dialog.js");
let root: Root;
let container: HTMLDivElement;
const apply = vi.fn();
const close = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  videoFilmstrip.mockResolvedValue([]);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:scene-trim");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  apply.mockResolvedValue(undefined);
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
async function mount() {
  await act(async () =>
    root.render(
      <PlayableVideoTrimDialog
        blob={new Blob(["original"])}
        clip={{ start: 2, end: 8 }}
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
function applyButton() {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Apply trim",
  )!;
}
it("disables Scene Apply after a video fails to load", async () => {
  const video = await mount();
  await act(async () => video.dispatchEvent(new Event("error")));
  expect(applyButton().disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  expect(apply).not.toHaveBeenCalled();
});
it("uses the shared handles without encoding or uploading on Scene Apply", async () => {
  await mount();
  const handle = document.querySelector(".video-trimmer-handle.is-start")!;
  await act(async () =>
    handle.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () => applyButton().click());
  expect(apply).toHaveBeenCalledExactlyOnceWith({ start: 2.1, end: 8 });
  expect(close).toHaveBeenCalledOnce();
  expect(trimVideo).not.toHaveBeenCalled();
  expect(uploadLibraryAsset).not.toHaveBeenCalled();
});
