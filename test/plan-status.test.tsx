import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanStatus } from "../src/renderer/plan-status.js";

describe("PlanStatus", () => {
  it("shows the current step in a collapsed summary and all steps when expanded", () => {
    const html = renderToStaticMarkup(<PlanStatus plan={{
      explanation: "Implementation progress",
      steps: [
        { step: "Inspect files", status: "completed" },
        { step: "Implement change", status: "in_progress" },
        { step: "Run tests", status: "pending" },
      ],
    }} />);

    expect(html).toContain("Step 2 / 3 · Implement change");
    expect(html).toContain("Implementation progress");
    expect(html).toContain("Inspect files");
    expect(html).toContain("Run tests");
    expect(html).not.toContain("<details open");
  });

  it("falls back to the first pending step", () => {
    const html = renderToStaticMarkup(<PlanStatus plan={{ steps: [
      { step: "Inspect files", status: "completed" },
      { step: "Run tests", status: "pending" },
    ] }} />);

    expect(html).toContain("Step 2 / 2 · Run tests");
  });

  it("renders nothing without a plan", () => {
    expect(renderToStaticMarkup(<PlanStatus />)).toBe("");
  });
});
