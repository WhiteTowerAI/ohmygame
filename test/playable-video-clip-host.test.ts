// @vitest-environment happy-dom
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocumentPlayableSurfaceHost } from "../src/shared/playable-sandbox.js";
import type { PlayableNodeContext } from "../src/shared/playable-nodes.js";

const moduleUrl = pathToFileURL(
  path.resolve("test/fixtures/playable-video-clip-page.mjs"),
).href;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanups.splice(0).forEach((stop) => stop());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mounting(
  attributes = 'data-clip-start="3" data-clip-end="5"',
  fails = false,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          `<div data-media="backdrop" data-type="video" data-asset="intro" ${attributes}><video></video></div>${fails ? "<span data-fail></span>" : ""}`,
        ),
    ),
  );
  const audioStop = vi.fn();
  let root: ShadowRoot | undefined;
  const watched = vi.fn((next: ShadowRoot) => {
    root = next;
    return audioStop;
  });
  const host = new DocumentPlayableSurfaceHost(document, undefined, watched, {
    base: new URL("https://story.test/"),
  });
  cleanups.push(() => host.destroy());
  const controller = new AbortController();
  cleanups.push(() => controller.abort());
  const mounted = host.mountNode(
    {
      id: "start",
      html: "nodes/start/index.html",
      css: "data:text/css,",
      javascript: moduleUrl,
      inputs: [],
    },
    { lifecycle: { signal: controller.signal } } as Omit<
      PlayableNodeContext,
      "root"
    >,
  );
  // Record an expected rejection immediately, while the stylesheet is still loading.
  const outcome = mounted.then(
    (surface) => ({ surface }),
    (error: unknown) => ({ error }),
  );
  await vi.waitFor(() => expect(root).toBeDefined());
  root!.querySelector("link")!.dispatchEvent(new Event("load"));
  return { outcome, root: root!, host, controller, audioStop, watched };
}

function playable(video: HTMLVideoElement) {
  let paused = true;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => paused },
    seeking: { configurable: true, value: false },
  });
  vi.spyOn(video, "play").mockImplementation(async () => {
    paused = false;
    video.dispatchEvent(new Event("play"));
  });
  vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
    video.dispatchEvent(new Event("pause"));
  });
}

it("clips a web-story page through the shared host without replacing its audio lifecycle", async () => {
  const { outcome, root, controller, audioStop, watched } = await mounting();
  const result = await outcome;
  if (!("surface" in result)) throw result.error;
  const video = root.querySelector("video")!;
  playable(video);
  expect(root.host.getAttribute("data-time-at-mount")).toBe("3");
  expect(watched).toHaveBeenCalledOnce();
  const ended = vi.fn();
  video.addEventListener("ended", ended);
  await video.play();
  video.currentTime = 5.1;
  video.dispatchEvent(new Event("timeupdate"));
  expect(video.paused).toBe(true);
  expect(video.currentTime).toBeCloseTo(4.999);
  expect(ended).toHaveBeenCalledOnce();
  controller.abort();
  await video.play();
  video.currentTime = 9;
  video.dispatchEvent(new Event("timeupdate"));
  expect(video.currentTime).toBe(9);
  expect(video.paused).toBe(false);
  result.surface.destroy();
  expect(audioStop).toHaveBeenCalledOnce();
  expect(root.host.isConnected).toBe(false);
});

it("leaves an untrimmed web-story video unchanged", async () => {
  const { outcome, root } = await mounting("");
  const result = await outcome;
  if (!("surface" in result)) throw result.error;
  const video = root.querySelector("video")!;
  playable(video);
  expect(root.host.getAttribute("data-time-at-mount")).toBe("0");
  await video.play();
  video.currentTime = 11;
  video.dispatchEvent(new Event("timeupdate"));
  expect(video.currentTime).toBe(11);
  expect(video.paused).toBe(false);
  result.surface.destroy();
});

it("releases both media observers on failed page mounts", async () => {
  const { outcome, root, host, audioStop } = await mounting(undefined, true);
  const result = await outcome;
  expect("error" in result && String(result.error)).toContain(
    "Fixture mount failed",
  );
  expect(audioStop).toHaveBeenCalledOnce();
  expect(host.projectRoot.querySelector("[data-playable-surface]")).toBeNull();
  const video = root.querySelector("video")!;
  playable(video);
  await video.play();
  video.currentTime = 9;
  video.dispatchEvent(new Event("timeupdate"));
  expect(video.currentTime).toBe(9);
});
