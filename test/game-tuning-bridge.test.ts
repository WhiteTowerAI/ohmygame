// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewBridgeScript } from "../src/daemon/preview-proxy.js";

class FakeEvents {
  static latest: FakeEvents;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() { FakeEvents.latest = this; }
  close() {}
  deliver(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

afterEach(() => {
  delete (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function bridge() {
  const script = previewBridgeScript(1, { client: "editor", source: "editor" });
  const sent: { type: string; diagnostic?: { message: string } }[] = [];
  vi.stubGlobal("EventSource", FakeEvents);
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
    if (init?.body) sent.push(JSON.parse(init.body));
    return new Response("{}");
  }));
  vi.useFakeTimers();
  new Function(script)();
  return { events: FakeEvents.latest, sent };
}
const reports = (sent: { type: string }[]) => sent.filter((message) => message.type === "tuning").length;

describe("the preview bridge's tuning", () => {
  it("gives the game what changed, when it is ready, and says it listens", async () => {
    const { events, sent } = await bridge();
    events.deliver({ reload: 0, tuning: { jump: 420, fly: false } });
    expect(reports(sent)).toBe(0);

    // Games define the setter when they have loaded, which can take a while.
    const set = vi.fn();
    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = { set };
    await vi.advanceTimersByTimeAsync(500);
    expect(set.mock.calls).toEqual([["jump", 420], ["fly", false]]);
    expect(reports(sent)).toBe(1);

    set.mockClear();
    events.deliver({ reload: 0, tuning: { jump: 500, fly: false } });
    expect(set.mock.calls).toEqual([["jump", 500]]);
    expect(reports(sent)).toBe(1);
  });

  it("starts over when the game replaces its setter, and says it listens after a reconnect", async () => {
    const { events, sent } = await bridge();
    const first = vi.fn(), second = vi.fn();
    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = { set: first };
    events.deliver({ reload: 0, tuning: { jump: 420 } });
    expect(first).toHaveBeenCalledOnce();

    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = { set: second };
    await vi.advanceTimersByTimeAsync(500);
    expect(second.mock.calls).toEqual([["jump", 420]]);

    events.onopen?.();
    await vi.advanceTimersByTimeAsync(500);
    expect(reports(sent)).toBe(2);
  });

  it("starts over when the game replaces only the setter function", async () => {
    const { events } = await bridge();
    const first = vi.fn(), second = vi.fn();
    const game = { set: first };
    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = game;
    events.deliver({ reload: 0, tuning: { jump: 420 } });
    game.set = second;
    await vi.advanceTimersByTimeAsync(500);
    expect(second.mock.calls).toEqual([["jump", 420]]);
  });

  it("starts over when a new object shares the setter function", async () => {
    const { events } = await bridge();
    const set = vi.fn();
    class Game { set(id: string, value: unknown) { set(this, id, value); } }
    const first = new Game(), second = new Game();
    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = first;
    events.deliver({ reload: 0, tuning: { jump: 420 } });
    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = second;
    await vi.advanceTimersByTimeAsync(500);
    expect(set.mock.calls).toEqual([[first, "jump", 420], [second, "jump", 420]]);
  });

  it("reports a setter that throws as a game error and carries on", async () => {
    const { events, sent } = await bridge();
    const set = vi.fn((id: string) => { if (id === "jump") throw new Error("no jump here"); });
    (window as { __OHMYGAME_TUNING__?: unknown }).__OHMYGAME_TUNING__ = { set };
    events.deliver({ reload: 0, tuning: { jump: 420, fly: true } });
    expect(set).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.find((message) => message.type === "diagnostic")?.diagnostic?.message).toContain("no jump here");
  });

  it("ignores a page without a setter", async () => {
    const { events, sent } = await bridge();
    events.deliver({ reload: 0, tuning: { jump: 420 } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reports(sent)).toBe(0);
  });
});

describe("the preview bridge's gamepad map", () => {
  const pad = { connected: true, mapping: "standard", buttons: [{ pressed: false }], axes: [0, 0] };
  async function playing() {
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    Object.defineProperty(navigator, "getGamepads", { configurable: true, writable: true, value: () => [pad] });
    const keys: string[] = [];
    const listen = (event: KeyboardEvent) => keys.push(`${event.type} ${event.code} ${event.key} ${event.keyCode}`);
    window.addEventListener("keydown", listen);
    window.addEventListener("keyup", listen);
    const { events } = await bridge();
    // Fake timers run animation frames too.
    const frame = () => vi.advanceTimersByTimeAsync(17);
    return { events, keys, frame, blur: (value: boolean) => { focused = !value; if (value) window.dispatchEvent(new Event("blur")); }, stop: () => { window.removeEventListener("keydown", listen); window.removeEventListener("keyup", listen); } };
  }
  const map = { buttons: [[0, "Space"]], axes: [[0, -1, "ArrowLeft"], [0, 1, "KeyD"]], deadZone: 0.5 };

  it("presses and lets go of keys as the pad changes, past the dead zone and only with focus", async () => {
    const { events, keys, frame, blur, stop } = await playing();
    events.deliver({ reload: 0, inputMap: map });
    pad.buttons[0]!.pressed = true;
    pad.axes[0] = -0.4;
    await frame();
    expect(keys).toEqual(["keydown Space   32"]);
    pad.axes[0] = -0.8;
    await frame();
    await frame();
    expect(keys).toEqual(["keydown Space   32", "keydown ArrowLeft ArrowLeft 37"]);
    pad.buttons[0]!.pressed = false;
    pad.axes[0] = 0.9;
    await frame();
    expect(keys.slice(2)).toEqual(["keyup Space   32", "keyup ArrowLeft ArrowLeft 37", "keydown KeyD d 68"]);
    // Losing focus lets every key go, and nothing is pressed until it is back.
    blur(true);
    await frame();
    expect(keys.slice(5)).toEqual(["keyup KeyD d 68"]);
    blur(false);
    await frame();
    expect(keys.slice(6)).toEqual(["keydown KeyD d 68"]);
    // Turning the map off lets go too.
    events.deliver({ reload: 0, inputMap: null });
    await frame();
    expect(keys.slice(7)).toEqual(["keyup KeyD d 68"]);
    pad.axes[0] = 0;
    stop();
  });

  it("stops when the game reads the pad itself", async () => {
    const { events, keys, frame, stop } = await playing();
    events.deliver({ reload: 0, inputMap: map });
    pad.buttons[0]!.pressed = true;
    await frame();
    expect(keys).toEqual(["keydown Space   32"]);
    navigator.getGamepads();
    await frame();
    expect(keys).toEqual(["keydown Space   32", "keyup Space   32"]);
    pad.buttons[0]!.pressed = false;
    stop();
  });
});
