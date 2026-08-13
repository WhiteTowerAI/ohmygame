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
});
