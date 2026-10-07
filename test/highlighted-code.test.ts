import { describe, expect, it, vi } from "vitest";
import { highlightWorkspaceCode } from "../src/renderer/highlighted-code.js";

const initialization = vi.hoisted(() => ({ failOnce: true }));
vi.mock("shiki/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("shiki/core")>();
  return {
    ...core,
    createHighlighterCore: async (...args: Parameters<typeof core.createHighlighterCore>) => {
      if (initialization.failOnce) {
        initialization.failOnce = false;
        return Promise.reject(new Error("Temporary highlighter initialization failure"));
      }
      const highlighter = await core.createHighlighterCore(...args);
      const codeToHtml = highlighter.codeToHtml.bind(highlighter);
      // Fixed short fixtures must finish tokenizing even on a busy CI runner.
      // Shiki's production 500ms budget can return a partly colored line.
      highlighter.codeToHtml = (code, options) => codeToHtml(code, { ...options, tokenizeTimeLimit: 0 });
      return highlighter;
    },
  };
});

describe("workspace code highlighting", () => {
  it("retries after failed initialization and renders colored, escaped code in both themes", async () => {
    await expect(highlightWorkspaceCode("const value = 1;", "javascript", "github-dark"))
      .rejects.toThrow("Temporary highlighter initialization failure");

    for (const theme of ["github-dark", "github-light"] as const) {
      for (const [language, content] of [
        ["typescript", 'export const scene: string = "Forest";'],
        ["javascript", 'export const scene = "Forest";'],
        ["json", '{ "name": "Forest", "count": 3 }'],
        ["tsx", 'export const Scene = () => <div title="Forest" />;'],
      ]) {
        const html = await highlightWorkspaceCode(content, language, theme);
        expect(html).toContain(`shiki ${theme}`);
        expect(new Set([...html.matchAll(/style="color:(#[A-Fa-f0-9]+)/g)].map((match) => match[1])).size, `${theme}/${language}: ${html}`)
          .toBeGreaterThan(1);
        if (language === "tsx") {
          expect(html).toMatch(/&(?:lt|#x0*3c|#0*60);/i);
          expect(html).not.toContain("<div");
        }
      }
    }
  });
});
