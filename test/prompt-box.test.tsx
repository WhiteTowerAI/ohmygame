import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PromptBox } from "../src/renderer/prompt-box.js";

describe("PromptBox", () => {
  it("stays focusable while read-only, so keystrokes do not fall through to the page", () => {
    const html = renderToStaticMarkup(<PromptBox value="hi" onChange={() => {}} onSubmit={() => {}} placeholder="" variant="project" actions={null} readOnly />);
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });
});
