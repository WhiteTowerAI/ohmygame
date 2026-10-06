import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../src/shared/events.js";

describe("RuntimeEventBus", () => {
  it("replays after a cursor and streams new events", () => {
    const bus = new RuntimeEventBus();
    const first = bus.publish("a", "preview.starting", {});
    bus.publish("b", "preview.starting", {});
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("a", listener);
    const second = bus.publish("a", "preview.stopped", {});

    expect(bus.since("a", first.id)).toEqual([second]);
    expect(listener).toHaveBeenCalledWith(second);
    unsubscribe();
  });

  it("retains only its configured replay capacity", () => {
    const bus = new RuntimeEventBus(2);
    bus.publish("a", "preview.starting", {});
    const second = bus.publish("a", "preview.stopped", {});
    const third = bus.publish("a", "preview.starting", {});

    expect(bus.since("a")).toEqual([second, third]);
    expect(bus.canReplay("a", 0)).toBe(false);
    expect(bus.canReplay("a", second.id - 1)).toBe(true);
  });

  it.each([false, true])("streams full data while retaining lightweight replay data with a pass-through projector: %s", (projected) => {
    const bus = new RuntimeEventBus(1_000, projected ? (event) => event : undefined);
    const listener = vi.fn();
    bus.subscribe("a", listener);
    const event = bus.publish("a", "agent.started", {
      prompt: "Describe",
      images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
    }, { conversationId: "conversation", turnId: "turn" }, { prompt: "Describe" });

    expect(bus.since("a")).toEqual([{ ...event, data: { prompt: "Describe" } }]);
    expect(listener).toHaveBeenCalledWith(event);
    expect(bus.canReplay("a", event.id - 1)).toBe(true);
    bus.expireThrough("a", event.id);
    expect(bus.canReplay("a", event.id - 1)).toBe(false);
    expect(bus.canReplay("a", event.id)).toBe(true);
  });
});
