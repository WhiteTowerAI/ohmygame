import { describe, expect, it } from "vitest";
import {
  createAssetCanvasDocument,
  isAssetCanvasDocument,
} from "../src/shared/asset-canvas.js";
import {
  actionSheetPrompt,
  allActionsPrompt,
  characterAssetPrompt,
  continuousActionsPrompt,
  preferredCharacterSheetOption,
  resolveContinuousActionPrompt,
} from "../src/shared/canvas-character-tools.js";
import { PIXEL_SPRITE_SEQUENCE_REQUIREMENTS, withCharacterPixelArtLevel, withGlobalPixelStyle } from "../src/shared/canvas-pixel-style.js";
import type { ImageModel } from "../src/shared/contracts.js";
import { toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";

describe("canvas character image tools", () => {
  it("builds distinct character prompts and does not wrap a prepared character prompt twice", () => {
    expect(characterAssetPrompt("pixel knight")).toContain("pixel knight");
    expect(characterAssetPrompt(characterAssetPrompt("pixel knight"))).toBe(
      characterAssetPrompt("pixel knight"),
    );
    const sheet = characterAssetPrompt("pixel knight");
    const coarseSheet = withCharacterPixelArtLevel(characterAssetPrompt("pixel knight", "coarse"), "coarse");
    const detailedSheet = withCharacterPixelArtLevel(characterAssetPrompt("pixel knight", "detailed"), "detailed");
    expect(sheet).toContain("largest and most visually prominent element");
    expect(sheet).toContain(
      "three distinct facial expressions",
    );
    expect(sheet).toContain("1. Front view.\n2. Side view.\n3. Back view.");
    expect(sheet).toContain("All views must depict exactly the same character");
    expect(sheet).toContain("repeated redundant portraits");
    expect(sheet).toContain("useful pixel art close-ups");
    expect(sheet).toContain("Do not add decorative frames, text, labels, captions, watermarks");
    expect(sheet).toContain("occupying approximately 45–50% of the sheet");
    expect(sheet).toContain("authentic low-resolution retro pixel art style");
    expect(sheet).toContain("selected logical pixel grid");
    expect(sheet).toContain("The selected density controls logical dimensions, palette, shading depth");
    expect(coarseSheet).toContain("selected logical pixel grid");
    expect(coarseSheet).toContain("same coarse pixel construction and color palette");
    expect(coarseSheet).toContain("32×32 logical sprite budget");
    expect(coarseSheet).toContain("each eye as one solid dark mark");
    expect(detailedSheet).toContain("192×192 logical sprite budget");
    expect(detailedSheet).toContain("small armor divisions");
    expect(detailedSheet).toContain("selected hair locks");
    expect(detailedSheet).toContain("4–6 hard-edged tones per major material");
    expect(sheet).toContain("Close-ups must not reintroduce engraving");
    expect(sheet).toContain("visibly omit secondary detail");
    expect(detailedSheet).toContain("Translate reference details into the selected pixel density");
    expect(detailedSheet).toContain("Follow the requested design theme while keeping the selected density");
    expect(detailedSheet).toContain("REFERENCE DESIGN, NOT REFERENCE RENDERING");
    expect(detailedSheet).toContain("CHARACTER DETAIL BUDGET:");
    expect(detailedSheet).not.toContain("Close-ups must not reintroduce engraving");
    expect(sheet).toContain("maintain consistent pixel scale");
    expect(sheet).not.toContain("Use high-quality Japanese anime-inspired");
    expect(characterAssetPrompt("  a fox knight $& $'  ")).toContain("CHARACTER DESCRIPTION: a fox knight $& $'");
    const previousPrompt = "Create a production-ready 2D game character reference sheet from this description: knight\n\nAn edited saved prompt.";
    expect(characterAssetPrompt(previousPrompt)).toBe(previousPrompt);
    expect(characterAssetPrompt("")).toMatch(/^CHARACTER DESCRIPTION: Follow the supplied reference/);
    expect(
      characterAssetPrompt(
        "Create a production-ready 2D game character asset from this description: pixel knight\n\nShow exactly one full-body character, centered and completely visible.",
      ),
    ).toBe(sheet);
    expect(continuousActionsPrompt("walk")).toContain("12 successive frames");
    expect(continuousActionsPrompt("walk")).toContain(
      "Requested action: walk",
    );
    expect(allActionsPrompt("idle, attack")).toContain("idle, attack");
    expect(allActionsPrompt("idle, attack")).toContain(
      "nine distinct full-body action poses",
    );
  });

  it("keeps custom actions framed consistently without freezing body movement", () => {
    const prompt = continuousActionsPrompt("raising one hand, waving, then lowering it");
    expect(prompt).toContain("Requested action: raising one hand, waving, then lowering it");
    expect(prompt).toContain(PIXEL_SPRITE_SEQUENCE_REQUIREMENTS);
    expect(prompt).toContain("per frame: 64×64 pixels");
    expect(prompt).toContain("Use no more than 16 colors across all artwork in the full output");
    expect(prompt).toContain("exactly 4 columns and 3 rows");
    expect(prompt).toContain("no outer margins or padding");
    expect(prompt).toContain("Fit the largest pose within approximately 80% of the cell height");
    expect(prompt).toContain("For stationary gestures, keep the supporting body and planted feet anchored");
    expect(prompt).toContain("consistent ground baseline as the coordinate reference");
    expect(prompt).toContain("Never independently recenter, crop, or rescale");
    expect(prompt).toContain("using a consistent full-body view throughout");
    expect(prompt).toContain("no visible grid lines, white separators, borders, gutters, labels, or extra characters");
    expect(prompt).toContain("For jumping, crouching, rolling, or falling, allow the body and feet to move");
    expect(prompt).toContain("do not force an attack or fall to loop");
    expect(prompt).not.toMatch(/USER_ACTION|\{user_prompt\}/);
    const template = continuousActionsPrompt("");
    expect(template).toContain("{USER_ACTION}");
    expect(resolveContinuousActionPrompt(template, "  wave $& $'  ")).toBe(continuousActionsPrompt("wave $& $'"));
    expect(() => resolveContinuousActionPrompt(template, "  ")).toThrow("Enter an action description");
    expect(resolveContinuousActionPrompt("User-edited instructions", "wave")).toBe("User-edited instructions\n\nRequested action: wave");
    const node = toAssetCanvasNode({ id: "action", type: "image", position: { x: 0, y: 0 }, data: { prompt: template, presetId: "continuous-sequence", promptExpanded: true, actionDescription: "wave" } });
    expect(node.data).toMatchObject({ prompt: template, actionDescription: "wave" });
    const canvas = createAssetCanvasDocument();
    canvas.nodes = [node];
    canvas.editorLayout.nodes.action = node.position;
    expect(isAssetCanvasDocument(canvas)).toBe(true);
  });

  it("uses a visible planted idle cycle and single-play combat actions", () => {
    const idle = actionSheetPrompt("idle", "a blue cape");
    expect(idle).toContain("3-row by 4-column grid");
    expect(idle).toContain("rather than 12 nearly identical standing poses");
    expect(idle).toContain("both feet planted in the same position");
    expect(idle).toContain("progressively bend the knees and lower the shoulders");
    expect(idle).toContain("must not walk, travel, or drift sideways");
    expect(idle).toContain("authentic low-resolution game pixel art");
    expect(idle).toContain("do not draw any grid lines, white dividers, borders, gaps, labels, checkerboard patterns, or extra characters");
    expect(idle).toContain("Make the last frame transition smoothly to the first");
    expect(idle).toContain("Additional direction: a blue cape");
    for (const action of ["attack", "hurt", "down"] as const) {
      const prompt = actionSheetPrompt(action);
      expect(prompt).toContain("12 successive frames");
      expect(prompt).toMatch(/fully contained within/);
      expect(prompt).toMatch(/[Dd]o not loop the last frame to the first/);
      expect(prompt).toContain("low-resolution game pixel art");
      expect(prompt).toContain(PIXEL_SPRITE_SEQUENCE_REQUIREMENTS);
    }
    expect(actionSheetPrompt("down")).toContain("remains on the ground in the final frame");
  });

  it.each(["idle", "walk", "run"] as const)("registers the %s cycle to the same cell origin without freezing animation", (action) => {
    const prompt = actionSheetPrompt(action);
    expect(prompt).toContain("pelvis horizontal anchor at 50%");
    expect(prompt).toContain("ground baseline at 90%");
    expect(prompt).toContain("never auto-center, crop, zoom, or rescale");
    expect(prompt).toContain(PIXEL_SPRITE_SEQUENCE_REQUIREMENTS);
    expect(prompt.indexOf(PIXEL_SPRITE_SEQUENCE_REQUIREMENTS)).toBeLessThan(prompt.indexOf("Use the supplied image"));
    if (action === "idle") {
      expect(prompt).toContain("3–4 logical pixel vertical range");
      expect(prompt).toContain("frame 4 deepest compression");
      expect(prompt).toContain("do not lock the entire body into one pose");
    } else {
      expect(prompt.match(/^F\d{2}:/gm)).toEqual(Array.from({ length: 12 }, (_, index) => `F${String(index + 1).padStart(2, "0")}:`));
      expect(prompt).toContain("same near/far identity in every frame");
      expect(prompt).toContain("SCREEN-RIGHT to SCREEN-LEFT");
      expect(prompt).toContain("Do not mirror the whole character or duplicate the first six frames");
      expect(prompt).toContain("without duplicating the first frame");
      if (action === "walk") {
        expect(prompt).toContain("head, torso, and hips in exactly the same screen position");
        expect(prompt).toContain("F04: Far-side leg passes close beside the near-side supporting leg");
        expect(prompt).toContain("F10: Near-side leg passes close beside the far-side supporting leg");
        expect(prompt).toContain("At least one foot remains grounded at every moment");
        expect(prompt).not.toContain("vertical bouncing");
      } else {
        expect(prompt).toContain("Allow natural small vertical bouncing and forward body lean");
        expect(prompt).toContain("F03: NEAR-SIDE foot pushes backward; FAR-SIDE bent knee passes beneath the hips");
        expect(prompt).toContain("F09: FAR-SIDE foot pushes backward; NEAR-SIDE bent knee passes beneath the hips");
        expect(prompt).toContain("F05: Brief low flight");
        expect(prompt).toContain("F11: Brief low flight");
        expect(prompt).toContain("heel folds toward the buttocks");
        expect(prompt).not.toContain("{user_prompt}");
      }
    }
  });

  it("prefers 16:9 for character sheets at the current resolution", () => {
    const model: ImageModel = {
      provider: "google",
      id: "character-sheet",
      name: "Character sheet",
      providerName: "Google",
      sizes: ["1024x1024"],
      supportsReferenceImage: true,
      maxOutputs: 1,
      protocol: "gemini-generate-content",
      generationOptions: [
        { resolution: "1K", aspectRatio: "1:1" },
        { resolution: "1K", aspectRatio: "16:9" },
        { resolution: "2K", aspectRatio: "16:9" },
        { resolution: "1K", aspectRatio: "21:9" },
        { resolution: "2K", aspectRatio: "21:9" },
      ],
    };
    expect(preferredCharacterSheetOption(model, "2K")).toEqual({
      resolution: "2K",
      aspectRatio: "16:9",
    });
    expect(
      preferredCharacterSheetOption(
        {
          ...model,
          generationOptions: model.generationOptions.filter(
            (option) => option.aspectRatio !== "21:9",
          ),
        },
        "2K",
      )?.aspectRatio,
    ).toBe("16:9");
    expect(
      preferredCharacterSheetOption({
        ...model,
        generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }],
      })?.aspectRatio,
    ).toBe("1:1");
  });

  it.each([
    ["character asset", characterAssetPrompt("pixel knight")],
    ["continuous actions", continuousActionsPrompt("walking")],
    ["all actions", allActionsPrompt("idle, attack")],
  ] as const)(
    "persists the %s prompt in an ordinary image node",
    (_mode, prompt) => {
      const canvas = createAssetCanvasDocument();
      canvas.nodes = [
        toAssetCanvasNode({
          id: "image",
          type: "image",
          position: { x: 0, y: 0 },
          data: {
            prompt,
            resolution: "1K",
            aspectRatio: "1:1",
            images: [],
          },
        }),
      ];
      canvas.editorLayout.nodes = { image: { x: 0, y: 0 } };
      expect(isAssetCanvasDocument(canvas)).toBe(true);
      expect(canvas.nodes[0]?.data).toMatchObject({ prompt });
      expect(Object.keys(canvas.nodes[0]!.data)).not.toContain(
        "generationMode",
      );
    },
  );

  it.each([
    ["character-asset", "knight", "production-oriented 2D pixel art game character"],
    ["continuous-actions", "walk", "12 successive frames"],
    ["all-actions", "idle, attack", "nine distinct full-body action poses"],
  ] as const)(
    "serializes a live legacy %s node without its old mode field",
    (generationMode, description, expected) => {
      const node = toAssetCanvasNode({
        id: "legacy",
        type: "image",
        position: { x: 0, y: 0 },
        data: {
          prompt: description,
          generationMode,
          pixelStyle: "detailed",
          resolution: "1K",
          aspectRatio: "1:1",
          images: [],
        },
      });
      if (node.type !== "image") throw new Error("Expected image node");
      expect(node.data.prompt).toContain(expected);
      expect(node.data).toMatchObject({ pixelStyle: "detailed", promptExpanded: true });
      expect(node.data.prompt.match(/\*\*PIXEL DENSITY:/g)).toHaveLength(1);
      expect(node.data.prompt).toContain("4–6 hard-edged tones per major material");
      expect(node.data).not.toHaveProperty("generationMode");
    },
  );
});
