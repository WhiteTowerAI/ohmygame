// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import Prism from "prismjs";
import "../src/renderer/code-highlight.worker.js";
import { HighlightedCode, workspaceLanguage } from "../src/renderer/highlighted-code.js";

const workers = vi.hoisted(() => ({ attempts: 0, terminated: 0 }));
vi.mock("../src/renderer/code-highlight.worker.ts?worker&inline", () => ({
  default: class {
    constructor() {
      if (++workers.attempts === 1) throw new Error("Temporary worker failure");
    }
    onmessage?: (event: { data: string }) => void;
    postMessage(request: string) {
      const { language, code } = JSON.parse(request);
      this.onmessage?.({ data: Prism.highlight(code, Prism.languages[language]!, language) });
    }
    terminate() { workers.terminated++; }
  },
}));

describe("workspace code highlighting", () => {
  it("loads every supported grammar and escapes markup in JSX and TSX", () => {
    for (const extension of ["css", "html", "js", "jsx", "json", "md", "mjs", "py", "ts", "tsx", "yaml", "yml"]) {
      const language = workspaceLanguage("scene." + extension)!;
      expect(Prism.languages[language]).toBeDefined();
    }
    for (const language of ["jsx", "tsx"]) {
      const html = Prism.highlight('export const Scene = () => <div title="Forest" />;', Prism.languages[language]!, language);
      expect(html).toContain("token keyword");
      expect(html).toContain("&lt;");
      expect(html).not.toContain("<div");
    }
  });

  it("keeps text readable on worker failure and retries on the next file", async () => {
    vi.stubGlobal("Worker", class {});
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(HighlightedCode, { path: "one.ts", content: "const one = 1;" })));
      await vi.waitFor(() => expect(workers.attempts).toBe(1));
      expect(container.querySelector("code")?.textContent).toBe("const one = 1;");
      await act(async () => root.render(createElement(HighlightedCode, { path: "two.ts", content: "const two = 2;" })));
      await vi.waitFor(() => expect(container.querySelector(".token.keyword")?.textContent).toBe("const"));
      expect(container.querySelector("code")?.textContent).toBe("const two = 2;");
      expect(workers.terminated).toBeGreaterThan(0);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("numbers plain text from one gutter, without the file's final newline", () => {
    const html = renderToStaticMarkup(createElement(HighlightedCode, { path: "notes.unknown", content: "one\ntwo\n" }));
    expect(html).toContain('<span class="workspace-code-gutter" aria-hidden="true">1\n2</span><code>one\ntwo</code>');
    // A long file stays two text nodes rather than an element per line.
    const long = renderToStaticMarkup(createElement(HighlightedCode, { path: "notes.unknown", content: "\n".repeat(50_000) }));
    expect(long.match(/<span/g)).toHaveLength(1);
    expect(long).toContain("\n49999\n50000</span>");
  });
});
