// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentPlayableAudio } from "../src/shared/playable-audio.js";

/** A media element whose playback the test controls. */
function playable<T extends HTMLMediaElement>(element: T, playing = false): T {
  let paused = !playing;
  Object.defineProperty(element, "paused", { get: () => paused, configurable: true });
  Object.defineProperty(element, "ended", { get: () => false, configurable: true });
  element.play = vi.fn(async () => {
    paused = false;
    element.dispatchEvent(new Event("play"));
  });
  element.pause = vi.fn(() => {
    paused = true;
    element.dispatchEvent(new Event("pause"));
  });
  return element;
}

describe("DocumentPlayableAudio", () => {
  let created: HTMLAudioElement[];
  beforeEach(() => {
    vi.useFakeTimers();
    created = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const element = create(tag);
      if (tag === "audio") created.push(playable(element as HTMLAudioElement));
      return element;
    }) as typeof document.createElement);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("fades music in at its volume and crossfades to the next track", () => {
    const audio = new DocumentPlayableAudio(document);
    audio.volumes({ music: 0.5, sound: 1 });
    audio.music("blob:theme", 1);
    const theme = created[0]!;
    expect(theme).toMatchObject({ src: "blob:theme", loop: true, volume: 0 });
    vi.advanceTimersByTime(1100);
    expect(theme.volume).toBeCloseTo(0.5);

    audio.music("blob:rain", 1);
    vi.advanceTimersByTime(1100);
    expect(theme.volume).toBe(0);
    expect(theme.pause).toHaveBeenCalled();
    expect(created[1]!.volume).toBeCloseTo(0.5);
    audio.dispose();
  });

  it("turns the music down while a Node's video plays with sound, and gives the video the sound volume", () => {
    const audio = new DocumentPlayableAudio(document);
    audio.volumes({ music: 0.8, sound: 0.6 });
    audio.music("blob:theme", 0);
    const theme = created[0]!;
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const video = playable(document.createElement("video"));
    root.append(video);
    const stop = audio.watchNode(root);

    void video.play();
    vi.advanceTimersByTime(500);
    expect(video.volume).toBeCloseTo(0.6);
    expect(theme.volume).toBeCloseTo(0.2);

    video.pause();
    vi.advanceTimersByTime(500);
    expect(theme.volume).toBeCloseTo(0.8);

    // A muted video is not heard, so the music stays up.
    video.muted = true;
    void video.play();
    vi.advanceTimersByTime(500);
    expect(theme.volume).toBeCloseTo(0.8);

    // The Node leaving while its video plays brings the music back.
    video.muted = false;
    video.dispatchEvent(new Event("volumechange"));
    vi.advanceTimersByTime(500);
    expect(theme.volume).toBeCloseTo(0.2);
    stop();
    vi.advanceTimersByTime(500);
    expect(theme.volume).toBeCloseTo(0.8);
    audio.dispose();
  });

  it("starts music held back by the browser at the player's first click", async () => {
    const audio = new DocumentPlayableAudio(document);
    audio.volumes({ music: 1, sound: 1 });
    const create = document.createElement.bind(document);
    vi.mocked(document.createElement).mockImplementationOnce(((tag: string) => {
      const element = playable(create(tag) as HTMLAudioElement);
      element.play = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "NotAllowedError" }))
        .mockResolvedValue(undefined);
      created.push(element);
      return element;
    }) as typeof document.createElement);
    audio.music("blob:theme", 0);
    await Promise.resolve();
    await Promise.resolve();
    window.dispatchEvent(new Event("pointerdown"));
    expect(created[0]!.play).toHaveBeenCalledTimes(2);
    audio.dispose();
  });
});
