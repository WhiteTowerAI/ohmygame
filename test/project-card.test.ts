import { describe, expect, it } from "vitest";
import { menuPlacement } from "../src/renderer/popover-placement.js";
import { projectTime } from "../src/renderer/project-card.js";

const NOW = new Date("2026-08-31T12:00:00");

describe("project time", () => {
  it("uses relative time for recent edits", () => {
    expect(projectTime("2026-08-31T11:59:30", NOW)).toBe("Edited just now");
    expect(projectTime("2026-08-31T11:48:00", NOW)).toBe("Edited 12m ago");
    expect(projectTime("2026-08-31T09:00:00", NOW)).toBe("Edited 3h ago");
    expect(projectTime("2026-08-29T12:00:00", NOW)).toBe("Edited 2d ago");
  });

  it("uses a date for older edits and includes the year when needed", () => {
    expect(projectTime("2026-08-24T11:59:59", NOW)).toBe("Edited Aug 24");
    expect(projectTime("2025-08-24T12:00:00", NOW)).toBe("Edited Aug 24, 2025");
  });
});

describe("project card menu placement", () => {
  const popup = { width: 108, height: 112 };
  const viewport = { width: 1200, height: 800 };

  it("opens below the trigger, right-aligned", () => {
    expect(menuPlacement({ top: 100, bottom: 130, right: 600 }, popup, viewport)).toEqual({ top: 134, left: 492 });
  });

  it("flips above the trigger near the bottom of the window", () => {
    expect(menuPlacement({ top: 720, bottom: 750, right: 600 }, popup, viewport)).toEqual({ top: 604, left: 492 });
  });

  it("can line up with the trigger's left edge", () => {
    expect(menuPlacement({ top: 100, bottom: 130, left: 300, right: 360 }, popup, viewport, "start")).toEqual({ top: 134, left: 300 });
  });

  it("stays inside the window when neither side fits", () => {
    expect(menuPlacement({ top: 40, bottom: 70, right: 60 }, popup, { width: 400, height: 150 })).toEqual({ top: 30, left: 8 });
  });
});
