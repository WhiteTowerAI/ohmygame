// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { waitForPlayableBackdrop } from "../src/shared/playable-surface-ready.js";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function setup(html: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = html;
  const controller = new AbortController();
  const diagnostic = vi.fn();
  return {
    root,
    controller,
    diagnostic,
    wait: () => waitForPlayableBackdrop(root, controller.signal, diagnostic),
  };
}

it("ignores non-background media and empty video placeholders", async () => {
  const { wait } = setup(
    '<img src="decoration.png"><div data-media="backdrop"><video></video></div>',
  );
  await wait();
});

it("accepts a cached image only after decode completes", async () => {
  const { root, wait } = setup(
    '<div data-media="backdrop"><img src="cached.png"></div>',
  );
  const image = root.querySelector("img")!;
  Object.defineProperty(image, "complete", { value: true });
  let decoded!: () => void;
  Object.defineProperty(image, "decode", {
    value: () =>
      new Promise<void>((resolve) => {
        decoded = resolve;
      }),
  });
  const done = vi.fn();
  const pending = wait().then(done);
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  decoded();
  await pending;
  expect(done).toHaveBeenCalledOnce();
});

it("accepts an already available paused video frame", async () => {
  const { root, wait } = setup(
    '<div data-media="backdrop"><video><source src="clip.mp4"></video></div>',
  );
  Object.defineProperty(root.querySelector("video"), "readyState", {
    value: 2,
  });
  await wait();
});

it("continues after an image error or rejected decode", async () => {
  const { root, wait } = setup(
    '<div data-media="backdrop"><img src="missing.png"></div>',
  );
  const pending = wait();
  root.querySelector("img")!.dispatchEvent(new Event("error"));
  await pending;
  const image = root.querySelector("img")!;
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "decode", {
    value: () => Promise.reject(new Error("decode failed")),
  });
  await wait();
});

it("bounds a stalled background wait and removes its timers and listeners", async () => {
  vi.useFakeTimers();
  const { wait, diagnostic } = setup(
    '<div data-media="backdrop"><video src="stalled.mp4"></video></div>',
  );
  const pending = wait();
  await vi.advanceTimersByTimeAsync(5_000);
  await pending;
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("aborts promptly and cancels a pending image decode timeout", async () => {
  vi.useFakeTimers();
  const { root, wait, controller, diagnostic } = setup(
    '<div data-media="backdrop"><img src="waiting.png"></div>',
  );
  const image = root.querySelector("img")!;
  Object.defineProperty(image, "complete", { value: true });
  Object.defineProperty(image, "decode", {
    value: () => new Promise(() => {}),
  });
  const outcome = wait().catch((error: unknown) => error);
  controller.abort();
  expect(await outcome).toMatchObject({ name: "AbortError" });
  expect(vi.getTimerCount()).toBe(0);
  expect(diagnostic).not.toHaveBeenCalled();
});
