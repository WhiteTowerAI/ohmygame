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
