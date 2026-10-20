// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  controlPlayableVideoClip,
  installPlayableVideoClips,
  parsePlayableVideoClip,
} from "../src/shared/playable-video-clip.js";
import {
  playableBackdropClipError,
  playableBackdropDetails,
  setPlayableBackdropClip,
  setPlayableBackdrop,
  clearPlayableBackdrop,
} from "../src/shared/playable-backdrop.js";

const html =
  '<main><div class="backdrop" data-media="backdrop" data-type="video" data-asset="intro" title="a > b"></div><p>Keep me</p></main>';
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function media(duration = 12) {
  const video = document.createElement("video");
  let paused = true;
  Object.defineProperties(video, {
    duration: { configurable: true, value: duration },
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
  return video;
}

describe("Scene video clipping", () => {
  it("writes only a single background's range and restores the exact source", () => {
    const expected = playableBackdropDetails(html)!;
    const edited = setPlayableBackdropClip(html, expected, {
      start: 3.2,
      end: 8.75,
    })!;
    expect(edited).toContain('data-clip-start="3.2" data-clip-end="8.75"');
    expect(edited).toContain("<p>Keep me</p>");
    expect(
      setPlayableBackdropClip(edited, playableBackdropDetails(edited)!),
    ).toBe(html);
    expect(
      setPlayableBackdropClip(edited, expected, { start: 1 }),
    ).toBeUndefined();
    expect(
      setPlayableBackdropClip(
        html.replace('data-asset="intro"', 'data-asset="new"'),
        expected,
        { start: 1 },
      ),
    ).toBeUndefined();
    expect(setPlayableBackdrop(edited, "new", "image")).not.toContain(
      "data-clip-",
    );
    expect(clearPlayableBackdrop(edited)).not.toContain("data-clip-");
  });

  it.each([
    'data-clip-start="-1"',
    'data-clip-start="NaN"',
    "data-clip-start",
    'data-clip-end=""',
    'data-clip-start="3" data-clip-end="3"',
    'data-clip-start="3" data-clip-end="2"',
    'data-clip-start="1" DATA-CLIP-START="2"',
  ])("rejects malformed authored ranges: %s", (attrs) => {
    expect(
      playableBackdropClipError(html.replace('title="a > b"', attrs)),
    ).toBeTruthy();
  });

  it("validates only real clip attributes, including images and ambiguous backgrounds", () => {
    expect(
      playableBackdropClipError(
        html.replace('title="a > b"', 'title="data-clip-start=oops"'),
      ),
    ).toBeUndefined();
    expect(
      playableBackdropClipError('<!-- <div data-clip-start="bad"> -->' + html),
    ).toBeUndefined();
    expect(
      playableBackdropClipError(
        html.replace(
          'data-type="video"',
          'data-type="image" data-clip-start="1"',
        ),
      ),
    ).toContain("video background");
    expect(
      playableBackdropClipError(
        html.replace('title="a > b"', 'data-clip-start="1"') +
          '<div data-media="backdrop"></div>',
      ),
    ).toContain("exactly one");
    expect(parsePlayableVideoClip(undefined, "5")).toEqual({
      start: 0,
      end: 5,
    });
    expect(parsePlayableVideoClip()).toBeUndefined();
  });

  it("seeks to the in point and emits one existing ended event at the out point", async () => {
    const video = media();
    const ended = vi.fn();
    const diagnostic = vi.fn();
    video.addEventListener("ended", ended);
    stops.push(
      controlPlayableVideoClip(video, { start: 3, end: 7 }, diagnostic),
    );
    expect(video.currentTime).toBe(3);
    await video.play();
    video.currentTime = 7.05;
    video.dispatchEvent(new Event("timeupdate"));
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBeCloseTo(6.999);
    video.dispatchEvent(new Event("timeupdate"));
    expect(ended).toHaveBeenCalledOnce();
    expect(diagnostic).not.toHaveBeenCalled();
    await video.play();
    expect(video.currentTime).toBe(3);
  });

  it("allows paused original-file scrubbing, then plays within the clip; loops without exiting", async () => {
    const video = media();
    video.loop = true;
    const ended = vi.fn();
    video.addEventListener("ended", ended);
    stops.push(controlPlayableVideoClip(video, { start: 2, end: 4 }, vi.fn()));
    video.currentTime = 9;
    video.dispatchEvent(new Event("timeupdate"));
    expect(video.currentTime).toBe(9);
    await video.play();
    expect(video.currentTime).toBe(2);
    video.currentTime = 4.1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(video.currentTime).toBe(2);
    expect(video.paused).toBe(false);
    expect(ended).not.toHaveBeenCalled();
  });

  it("waits for metadata and falls back once when the start is beyond the file", () => {
    const video = media(Number.NaN);
    const diagnostic = vi.fn();
    stops.push(controlPlayableVideoClip(video, { start: 30 }, diagnostic));
    expect(video.currentTime).toBe(0);
    Object.defineProperty(video, "duration", { configurable: true, value: 12 });
    video.dispatchEvent(new Event("loadedmetadata"));
    video.dispatchEvent(new Event("durationchange"));
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(0);
  });

  it("clips a dynamically created background without touching other or legacy videos, and cleans up", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html.replace(
      'title="a > b"',
      'data-clip-start="3" data-clip-end="5"',
    );
    const stop = installPlayableVideoClips(root);
    stops.push(stop);
    const video = media();
    root.querySelector(".backdrop")!.append(video);
    const other = media();
    root.append(other);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(video.currentTime).toBe(3);
    expect(other.currentTime).toBe(0);
    stop();
    await video.play();
    video.currentTime = 6;
    video.dispatchEvent(new Event("timeupdate"));
    expect(video.paused).toBe(false);
    video.pause();
  });

  it("does not change legacy video playback or synthesize duplicate natural ends", async () => {
    const video = media();
    const ended = vi.fn();
    video.addEventListener("ended", ended);
    stops.push(controlPlayableVideoClip(video, { start: 2, end: 30 }, vi.fn()));
    await video.play();
    video.pause();
    video.currentTime = 12;
    video.dispatchEvent(new Event("ended"));
    video.dispatchEvent(new Event("timeupdate"));
    expect(ended).toHaveBeenCalledOnce();
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = html;
    const legacy = media();
    root.querySelector(".backdrop")!.append(legacy);
    const added = vi.spyOn(legacy, "addEventListener");
    stops.push(installPlayableVideoClips(root));
    expect(added).not.toHaveBeenCalled();
    expect(legacy.currentTime).toBe(0);
  });
});
