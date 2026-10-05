import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectCreateDialog } from "../src/renderer/project-create-dialog.js";
import { GAME_PROJECT_TYPES } from "../src/renderer/project-types.js";

describe("project create dialog", () => {
  it("creates blank Interactive Story projects without asking for a canvas format", () => {
    const html = renderToStaticMarkup(<ProjectCreateDialog fixedType="interactive-story" onClose={() => undefined} onCreated={() => undefined} />);
    // Examples are played and remixed from Explore, not chosen here.
    expect(html).not.toContain("Sample project");
    expect(html).not.toContain("Start from");
    // New stories are 16:9; the format is changed in the project's settings.
    expect(html).not.toContain("Canvas format");
    expect(html).not.toContain("Portrait");
  });

  it("does not show Interactive Story templates for other project types", () => {
    const html = renderToStaticMarkup(<ProjectCreateDialog fixedType="web-game" onClose={() => undefined} onCreated={() => undefined} />);
    expect(html).not.toContain("Last Train Home");
  });

  it("can omit Asset Canvas from the home dialog", () => {
    const html = renderToStaticMarkup(<ProjectCreateDialog projectTypes={GAME_PROJECT_TYPES} onClose={() => undefined} onCreated={() => undefined} />);
    expect(html).not.toContain("Asset Canvas");
  });
});
