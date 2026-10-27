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
      Math.abs(Math.log(aspect(a.aspectRatio) / (16 / 9))) -
      Math.abs(Math.log(aspect(b.aspectRatio) / (16 / 9))) ||
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
  const character = subject || "a young male fantasy RPG adventurer with messy dark brown hair, a dark charcoal scarf, brown leather armor, belts, and boots";
  return `${newPrefix} ${character}\n\nCreate a professional 16:9 fantasy RPG character reference sheet with a clear visual hierarchy: character reference → main character illustration → turnaround, expressions, and detail references. On the left, show one large detailed upper-body character portrait as the largest visual element, occupying roughly half the sheet. Arrange the smaller supporting references around it on the right: three consistent front, side, and back full-body views, a small grid of three distinct facial expressions, and a few useful costume, accessory, or equipment detail close-ups. Avoid repeated similar portraits or redundant head angles; every supporting view must serve a distinct production purpose. These are repeated views of the same character, not different people. Maintain identical facial features, hairstyle, costume details, colors, and proportions across every view. Use high-quality Japanese anime-inspired game concept art, clean linework, and a soft neutral gray background unless the supplied description or reference specifies another art style. Keep the composition organized and readable at thumbnail size, with clear spacing and complete turnaround figures. No text, no labels, no watermark, no unrelated props, and no extra characters.`;
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
