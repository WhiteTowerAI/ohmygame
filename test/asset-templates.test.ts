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

  it("provides visible prompts for specialized templates", () => {
    const template = templatesForMode("image").find((candidate) => candidate.id === "character-turnaround");
    expect(template).toBeDefined();
    expect(template?.defaultPrompt).toMatch(/^Create a clean production character turnaround sheet/);
  });

  it("keeps general templates open-ended", () => {
    expect(defaultTemplateForMode("image").defaultPrompt).toBeUndefined();
  });

  it("makes specialized 3D prompts visible by selecting text input", () => {
    const templates = templatesForMode("3d");
    expect(defaultTemplateForMode("3d").defaults?.model3DSource).toBe("image");
    expect(templates.every((template) => template.defaults?.model3DModel === "meshy-t2")).toBe(true);
    expect(templates.every((template) => template.defaults?.model3DTargetPolycount === 4_000)).toBe(true);
    expect(templates.filter((template) => template.defaultPrompt).every((template) => template.defaults?.model3DSource === "text")).toBe(true);
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
