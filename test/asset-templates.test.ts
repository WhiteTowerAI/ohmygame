import { describe, expect, it } from "vitest";
import { defaultTemplateForMode, templatesForMode } from "../src/renderer/asset-templates.js";
import { isAssetTemplateDefinition } from "../src/shared/asset-templates.js";

describe("asset templates", () => {
  it("provides a default template for every studio mode", () => {
    for (const mode of ["image", "video", "3d"] as const) {
      const templates = templatesForMode(mode);
      expect(templates.length).toBeGreaterThan(0);
      expect(defaultTemplateForMode(mode)).toBe(templates[0]);
      expect(templates.every((template) => template.mode === mode)).toBe(true);
    }
  });

  it("uses unique template ids", () => {
    const templates = (["image", "video", "3d"] as const).flatMap((mode) => templatesForMode(mode));
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
  });

  it("only includes the general template for each mode", () => {
    expect((["image", "video", "3d"] as const).map((mode) => templatesForMode(mode).map((template) => template.id)))
      .toEqual([["general-image"], ["general-video"], ["general-3d"]]);
    expect((["image", "video", "3d"] as const).every((mode) => defaultTemplateForMode(mode).defaultPrompt === undefined)).toBe(true);
  });

  it("uses Meshy T2 for the general 3D template", () => {
    const templates = templatesForMode("3d");
    expect(defaultTemplateForMode("3d").defaults?.model3DSource).toBe("image");
    expect(templates.every((template) => template.defaults?.model3DModel === "meshy-t2")).toBe(true);
    expect(templates.every((template) => template.defaults?.model3DTargetPolycount === 4_000)).toBe(true);
  });

  it("validates model-specific 3D template defaults", () => {
    const template = {
      mode: "3d",
      name: "Game-ready prop",
      description: "",
      promptPlaceholder: "Describe a prop",
      defaults: { model3DModel: "meshy-t2", model3DTargetPolycount: 4_000 },
    };

    expect(isAssetTemplateDefinition(template)).toBe(true);
    expect(isAssetTemplateDefinition({ ...template, promptLabel: "Legacy prompt" })).toBe(true);
    expect(isAssetTemplateDefinition({ ...template, defaults: { ...template.defaults, model3DQuality: "ultra" } })).toBe(false);
    expect(isAssetTemplateDefinition({ ...template, defaults: { model3DQuality: "ultra" } })).toBe(true);
  });
});
