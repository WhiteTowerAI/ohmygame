import { describe, expect, it } from "vitest";
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
