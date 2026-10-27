// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromptBox } from "../src/renderer/prompt-box.js";

describe("PromptBox", () => {
  it("stays focusable while read-only, so keystrokes do not fall through to the page", () => {
    const html = renderToStaticMarkup(<PromptBox value="hi" onChange={() => {}} onSubmit={() => {}} placeholder="" variant="project" actions={null} readOnly />);
    expect(html).toMatch(/<textarea[^>]*readOnly=""/);
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it.each(["", "A saved draft that wraps when the pane gets narrower"])("remeasures unchanged text when the pane expands or resizes: %j", async (value) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let onResize: () => void = () => {};
    let disconnected = false;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { onResize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    });
    let width = 4;
    let contentHeight = 268;
    vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    const measure = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<PromptBox value={value} onChange={() => {}} onSubmit={() => {}} placeholder="Ask for a change" variant="project" actions={null} />));
      const input = host.querySelector("textarea")!;
      expect(input.style.height).toBe("132px");

      width = 358;
      contentHeight = 32;
      onResize();
      expect(input.style.height).toBe("33px");
      expect(input.value).toBe(value);

      // Height notifications from auto-sizing must not cause another measurement.
      measure.mockClear();
      onResize();
      expect(measure).not.toHaveBeenCalled();

      width = 200;
      contentHeight = 72;
      onResize();
      expect(input.style.height).toBe("73px");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
    expect(disconnected).toBe(true);
  });
});
