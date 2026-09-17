import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectCreateDialog } from "../src/renderer/project-create-dialog.js";

describe("project create dialog", () => {
  it("offers blank and sample starts for Interactive Drama", () => {
    const html = renderToStaticMarkup(<ProjectCreateDialog fixedType="interactive-drama" onClose={() => undefined} onCreated={() => undefined} />);
    expect(html).toContain("Blank project");
    expect(html).toContain("Last Train Home");
    expect(html).toContain('aria-pressed="true"');
  });

  it("does not show Interactive Drama templates for other project types", () => {
    const html = renderToStaticMarkup(<ProjectCreateDialog fixedType="web-game" onClose={() => undefined} onCreated={() => undefined} />);
    expect(html).not.toContain("Last Train Home");
  });
});
