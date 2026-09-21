import { describe, expect, it } from "vitest";
import { SceneTimerClock } from "../src/renderer/scene-timer-clock.js";

describe("SceneTimerClock", () => {
  it("advances only while running and resumes from the paused time", () => {
    const clock = new SceneTimerClock(400, 3_000);
    clock.resume(1_000);
    expect(clock.elapsed(1_600)).toBe(1_000);

    clock.pause(1_600);
    expect(clock.elapsed(8_000)).toBe(1_000);
    expect(clock.remaining(8_000)).toBe(2_000);

    clock.resume(8_000);
    expect(clock.elapsed(10_500)).toBe(3_000);
    expect(clock.remaining(10_500)).toBe(0);
  });

  it("restores elapsed time and clamps it when duration changes", () => {
    const clock = new SceneTimerClock(2_500, 5_000);
    expect(clock.remaining(0)).toBe(2_500);
    clock.setDuration(2_000);
    expect(clock.elapsed(0)).toBe(2_000);
    expect(clock.remaining(0)).toBe(0);
  });
});
