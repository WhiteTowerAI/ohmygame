// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasMarkdown } from "../src/renderer/canvas-document-node.js";
import { MarkdownContent } from "../src/renderer/markdown-content.js";
import * as api from "../src/renderer/api.js";
import type { CanvasMarkdownDocument } from "../src/shared/canvas-document.js";

const canvasDocument: CanvasMarkdownDocument = {
  id: "rules",
  title: "Rules",
  markdown: "# Rules\n\n![Concept](../assets/concept.png)",
};
let container: HTMLDivElement;
let root: Root;
let sequence: number;
const createObjectURL = vi.fn((_blob: Blob) => `blob:preview-${++sequence}`);
const revokeObjectURL = vi.fn((_url: string) => {});

beforeEach(() => {
  sequence = 0;
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    },
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "getWorkspaceAsset").mockResolvedValue(
    new Blob([], { type: "image/png" }),
  );
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderCanvas(next = canvasDocument, projectId = "project-1") {
  await act(async () =>
    root.render(<CanvasMarkdown projectId={projectId} document={next} />),
  );
}

describe("canvas Markdown media lifecycle", () => {
  it("keeps the loaded image mounted through canvas and document metadata updates", async () => {
    await renderCanvas();
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:preview-1");
    for (let revision = 0; revision < 4; revision++) {
      await renderCanvas({ ...canvasDocument, title: `Rules ${revision}` });
      expect(container.querySelector("img")).toBe(image);
    }
    expect(api.getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      "canvas/assets/concept.png",
    );
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("updates the surrounding Markdown without reloading an unchanged image", async () => {
    await renderCanvas();
    const image = container.querySelector("img");
    await renderCanvas({
      ...canvasDocument,
      markdown: canvasDocument.markdown.replace("# Rules", "# Revised rules"),
    });
    expect(container.querySelector("h1")?.textContent).toBe("Revised rules");
    expect(container.querySelector("img")).toBe(image);
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("loads a changed image source and releases its previous URL", async () => {
    await renderCanvas();
    await renderCanvas({
      ...canvasDocument,
      markdown: canvasDocument.markdown.replace("concept.png", "revised.png"),
    });
    expect(api.getWorkspaceAsset).toHaveBeenLastCalledWith(
      "project-1",
      "canvas/assets/revised.png",
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview-2",
    );
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  });

  it("resolves images against the current project and document location", async () => {
    await renderCanvas({
      ...canvasDocument,
      markdown: "![Concept](rules/concept.png)",
    });
    await renderCanvas(
      {
        ...canvasDocument,
        id: "revised",
        markdown: "![Concept](revised/concept.png)",
      },
      "project-2",
    );
    expect(api.getWorkspaceAsset).toHaveBeenNthCalledWith(
      1,
      "project-1",
      "canvas/documents/rules/concept.png",
    );
    expect(api.getWorkspaceAsset).toHaveBeenNthCalledWith(
      2,
      "project-2",
      "canvas/documents/revised/concept.png",
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview-2",
    );
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
  });

  it("keeps an unavailable image's error until an explicit retry", async () => {
    vi.mocked(api.getWorkspaceAsset).mockRejectedValueOnce(
      new Error("File missing"),
    );
    await renderCanvas();
    await renderCanvas({
      ...canvasDocument,
      markdown: canvasDocument.markdown.replace("# Rules", "# Revised rules"),
    });
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(".design-image-placeholder")?.textContent,
    ).toContain("Image unavailable");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".design-image-placeholder button")!
        .click(),
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:preview-1",
    );
  });
});

describe("Markdown component updates", () => {
  it("keeps copy feedback for unchanged code and clears it when the code changes", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const markdown = "# Rules\n\n```ts\nconst value = 1;\n```";
    await act(async () => root.render(<MarkdownContent text={markdown} />));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("button")?.textContent).toBe("Copied");
    await act(async () =>
      root.render(
        <MarkdownContent
          text={markdown.replace("# Rules", "# Revised rules")}
        />,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("Copied");
    await act(async () =>
      root.render(
        <MarkdownContent text={markdown.replace("value = 1", "value = 2")} />,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("Copy");
  });

  it("uses the latest workspace link callback and path", async () => {
    const original = vi.fn();
    const updated = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownContent
          text="[Rules](/workspace/one/rules.md)"
          workspacePath="/workspace/one"
          onOpenWorkspaceFile={original}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <MarkdownContent
          text="[Rules](/workspace/one/rules.md)"
          workspacePath="/workspace/one"
          onOpenWorkspaceFile={updated}
        />,
      ),
    );
    await act(async () => container.querySelector("a")!.click());
    expect(original).not.toHaveBeenCalled();
    expect(updated).toHaveBeenCalledExactlyOnceWith("rules.md");
    await act(async () =>
      root.render(
        <MarkdownContent
          text="[Rules](/workspace/one/rules.md)"
          workspacePath="/workspace/two"
          onOpenWorkspaceFile={updated}
        />,
      ),
    );
    expect(container.querySelector(".workspace-file-link")).toBeNull();
  });

  it("loads images from the correct project for each Markdown document", async () => {
    await act(async () =>
      root.render(
        <>
          <CanvasMarkdown projectId="project-1" document={canvasDocument} />
          <CanvasMarkdown projectId="project-2" document={canvasDocument} />
        </>,
      ),
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledWith(
      "project-1",
      "canvas/assets/concept.png",
    );
    expect(api.getWorkspaceAsset).toHaveBeenCalledWith(
      "project-2",
      "canvas/assets/concept.png",
    );
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });
});
