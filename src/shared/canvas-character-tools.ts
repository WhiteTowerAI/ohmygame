import type {
  AssetCanvasDocument,
  ImageModel,
  ImageResolution,
} from "./contracts.js";

export function preferredCharacterSheetOption(
  model?: ImageModel,
  resolution?: ImageResolution,
): ImageModel["generationOptions"][number] | undefined {
  return model?.generationOptions.slice().sort((a, b) => {
    const aspect = (ratio: string) => {
      const [width, height] = ratio.split(":").map(Number);
      return width! / height!;
    };
    return (
      aspect(b.aspectRatio) - aspect(a.aspectRatio) ||
      Number(b.resolution === resolution) -
        Number(a.resolution === resolution) ||
      Number(b.resolution === "1K") - Number(a.resolution === "1K")
    );
  })[0];
}

export function characterAssetPrompt(description: string): string {
  const prompt = description.trim();
  const newPrefix =
    "Create a production-ready 2D game character reference sheet from this description:";
  if (prompt.startsWith(newPrefix)) return prompt;
  const oldPrefix =
    "Create a production-ready 2D game character asset from this description:";
  const subject = prompt.startsWith(oldPrefix)
    ? prompt
        .slice(oldPrefix.length)
        .split("\n\nShow exactly one full-body character")[0]!
        .trim()
    : prompt;
  return `${newPrefix} ${subject}\n\nMake one wide landscape image divided into four clearly separated panels, read left to right. Panel 1: one complete full-body neutral standing view. Panel 2: a large waist-up portrait with a clearly visible face and outfit details. Panel 3: a 3-by-3 grid of nine head-and-shoulders expressions. Panel 4: a turnaround with complete front, side, and back full-body views, plus a few matching head close-ups from different angles. These are repeated views of the same character, not different people. Keep the face, hairstyle, body proportions, clothing, colors, accessories, and art style consistent across every panel; only the requested view or expression should change. Show complete figures without cropping, give each view enough space to read, and use clean plain backgrounds with visible gutters between panels. Do not add text, labels, unrelated props, extra characters, or a scene.`;
}

export function continuousActionsPrompt(action: string): string {
  return `Use the supplied image as the exact character reference. Create one sprite sheet showing a continuous ${action.trim()} animation as 12 successive frames in a 3-row by 4-column grid, read left to right, top to bottom. Each frame must show the same full-body character at the same scale and camera angle, with the same face, hairstyle, outfit, colors, accessories, and art style. Advance the pose smoothly between adjacent frames and make the final frame transition naturally back to the first. Use equal-sized cells, consistent baselines and spacing, a plain uniform background, and no labels, borders, extra characters, or unrelated objects.`;
}

export function allActionsPrompt(actions: string): string {
  return `Use the supplied image as the exact character reference. Create one 3-row by 3-column sprite sheet of nine distinct full-body action poses for this character. Requested actions: ${actions.trim()}. If fewer than nine actions are specified, add useful game actions. Keep the same face, hairstyle, outfit, colors, accessories, proportions, camera angle, and art style in every cell. Show one complete character per equal-sized cell, with a consistent scale and baseline and a plain uniform background. Do not add text, labels, borders, extra characters, or unrelated objects.`;
}

export function normalizeLegacyCharacterModes(
  canvas: AssetCanvasDocument,
): AssetCanvasDocument {
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => {
      if (node.type !== "image" || !node.data.generationMode) return node;
      const { generationMode, ...data } = node.data;
      const prompt =
        generationMode === "character-asset"
          ? characterAssetPrompt(data.prompt)
          : generationMode === "continuous-actions"
            ? continuousActionsPrompt(data.prompt)
            : allActionsPrompt(data.prompt);
      return { ...node, data: { ...data, prompt } };
    }),
  };
}
