import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PlanApprovalCard } from "../src/renderer/plan-approval-card.js";

describe("PlanApprovalCard", () => {
  it("renders the final plan approval independently from the composer", () => {
    const html = renderToStaticMarkup(
      <PlanApprovalCard onApprove={vi.fn()} onRefine={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(html).toContain("Implement this plan?");
    expect(html).toContain("Yes, implement this plan");
    expect(html).toContain("No, and tell OpenGame what to do differently");
    expect(html).toContain("Skip");
  });
});
