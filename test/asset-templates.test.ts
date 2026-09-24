import { describe, expect, it } from "vitest";
import { STUDIO_PROMPT_PLACEHOLDERS } from "../src/renderer/asset-templates.js";
import { isAssetTemplateDefinition } from "../src/shared/asset-templates.js";

describe("asset templates", () => {
  it("keeps empty-state prompt hints separate from templates", () => {
    expect(STUDIO_PROMPT_PLACEHOLDERS).toEqual({
      image: "A stylized floating island at sunrise, soft volumetric light, game concept art...",
      video: "Describe the scene, motion, and camera movement...",
      "3d": "A stylized wooden treasure chest with iron bands and a hinged lid...",
    });
  });

  it("validates 3D template defaults", () => {
    const template = {
      mode: "3d",
      name: "Game-ready prop",
      description: "",
      promptPlaceholder: "Describe a prop",
      defaults: { model3DTargetPolycount: 4_000 },
    };

    expect(isAssetTemplateDefinition(template)).toBe(true);
    expect(isAssetTemplateDefinition({ ...template, promptLabel: "Legacy prompt" })).toBe(true);
    expect(isAssetTemplateDefinition({ ...template, defaults: { ...template.defaults, unsupported: true } })).toBe(false);
    expect(isAssetTemplateDefinition({ ...template, defaults: { model3DTargetPolycount: 99 } })).toBe(false);
  });
});
