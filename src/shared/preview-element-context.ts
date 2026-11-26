import type { PreviewPick, PromptContext } from "./contracts.js";

/** An element picked in a web game's preview; the agent finds it in source from these clues. */
export function previewElementContext(pick: PreviewPick): PromptContext {
  const excerpt = pick.text ? ` "${pick.text}"` : "";
  return {
    kind: "preview-element",
    label: `<${pick.tag}>${excerpt}`.slice(0, 200),
    text: [
      `The user picked this element in the game preview, on page ${pick.path}:`,
      `Element: <${pick.tag}>${excerpt}`,
      `CSS path: ${pick.selector}`,
      `Box in page pixels: x ${pick.box.x}, y ${pick.box.y}, ${pick.box.width}×${pick.box.height}`,
      "Find it in the project source from its text, classes and structure. Elements created by script have no markup of their own.",
    ].join("\n"),
  };
}
