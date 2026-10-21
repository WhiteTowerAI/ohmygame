import { describe, expect, it } from "vitest";
import {
  createAssetCanvasDocument,
  isAssetCanvasDocument,
} from "../src/shared/asset-canvas.js";
import {
  allActionsPrompt,
  characterAssetPrompt,
  continuousActionsPrompt,
  preferredCharacterSheetOption,
} from "../src/shared/canvas-character-tools.js";
import type { ImageModel } from "../src/shared/contracts.js";
import { toAssetCanvasNode } from "../src/renderer/asset-canvas-workspace.js";

describe("canvas character image tools", () => {
  it("builds distinct character prompts and does not wrap a prepared character prompt twice", () => {
    expect(characterAssetPrompt("pixel knight")).toContain("pixel knight");
    expect(characterAssetPrompt(characterAssetPrompt("pixel knight"))).toBe(
      characterAssetPrompt("pixel knight"),
    );
    const sheet = characterAssetPrompt("pixel knight");
    expect(sheet).toContain("four clearly separated panels");
    expect(sheet).toContain(
      "3-by-3 grid of nine head-and-shoulders expressions",
    );
    expect(sheet).toContain("front, side, and back full-body views");
    expect(sheet).toContain("repeated views of the same character");
    expect(
      characterAssetPrompt(
        "Create a production-ready 2D game character asset from this description: pixel knight\n\nShow exactly one full-body character, centered and completely visible.",
      ),
    ).toBe(sheet);
    expect(continuousActionsPrompt("walk")).toContain("12 successive frames");
    expect(continuousActionsPrompt("walk")).toContain(
      "continuous walk animation",
    );
    expect(allActionsPrompt("idle, attack")).toContain("idle, attack");
    expect(allActionsPrompt("idle, attack")).toContain(
      "nine distinct full-body action poses",
    );
  });

  it("chooses the widest supported character sheet ratio at the current resolution", () => {
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
      aspectRatio: "21:9",
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
    ["character-asset", "knight", "production-ready 2D game character"],
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
          resolution: "1K",
          aspectRatio: "1:1",
          images: [],
        },
      });
      if (node.type !== "image") throw new Error("Expected image node");
      expect(node.data.prompt).toContain(expected);
      expect(node.data).not.toHaveProperty("generationMode");
    },
  );
});
