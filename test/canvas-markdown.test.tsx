// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasMarkdown } from "../src/renderer/canvas-document-node.js";
import { MarkdownContent } from "../src/renderer/markdown-content.js";
import * as api from "../src/renderer/api.js";
import type { CanvasMarkdownDocument } from "../src/shared/canvas-document.js";
import { DesignDocumentPanel } from "../src/renderer/design-document-panel.js";
import { useCanvasDocuments, type CanvasDocumentsState } from "../src/renderer/use-canvas-documents.js";
import * as canvasApi from "../src/renderer/canvas-api.js";

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

describe("the design document panel", () => {
  const rules = { id: "rules", title: "Rules", markdown: "# Rules\n\n## Combat\n\nHit hard.\n\n### Cards\n\nDraw three.\n\n## Map", revision: "1", source: "canvas/documents/rules.md", main: true };
  const lore = { id: "lore", title: "Lore", markdown: "# Lore", revision: "1", source: "canvas/documents/lore.md", main: false };
  function documentsState(documents: (typeof rules)[]) {
    return {
      workspace: { version: 1, boards: [{ id: "main", name: "Main" }], documents, assets: [] },
      update: vi.fn(), create: vi.fn(async () => "new"), setMain: vi.fn(async () => {}), refresh: vi.fn(async () => {}), flush: vi.fn(async () => {}),
      resolve: vi.fn(), saving: false, error: undefined, loadError: undefined, conflict: undefined,
    } as unknown as CanvasDocumentsState;
  }
  async function renderPanel(documents: CanvasDocumentsState, props: Partial<Parameters<typeof DesignDocumentPanel>[0]> = {}) {
    const toolbar = window.document.createElement("div");
    container.append(toolbar);
    const handlers = { onReference: vi.fn(), onQuote: vi.fn(), onAskAgent: vi.fn() };
    await act(async () => root.render(<DesignDocumentPanel project={{ id: "project-1" }} documents={documents} toolbarTarget={toolbar} {...handlers} {...props} />));
    return { toolbar, ...handlers };
  }

  it("reads the main document with its outline, and edits it as Markdown", async () => {
    const documents = documentsState([lore, rules]);
    const { toolbar } = await renderPanel(documents);
    expect(toolbar.querySelector(".design-doc-picker")?.textContent).toBe("Rules");
    expect([...container.querySelectorAll(".design-doc-outline-item")].map((item) => `${item.className.includes("is-h3") ? "  " : ""}${item.textContent}`))
      .toEqual(["Combat", "  Cards", "Map"]);
    await act(async () => [...toolbar.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit")!.click());
    const source = container.querySelector<HTMLTextAreaElement>(".design-doc-source")!;
    expect(source.value).toBe(rules.markdown);
    expect(container.querySelector(".design-doc-outline")).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(source, "# Rules\n\nNew");
      source.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(documents.update).toHaveBeenCalledWith("rules", { markdown: "# Rules\n\nNew" });
  });

  it("references the document in the next message, and stops", async () => {
    const documents = documentsState([rules]);
    const reference = () => toolbar.querySelector<HTMLButtonElement>("button[aria-label='Reference in chat'], button[aria-label='Stop referencing in chat']")!;
    let { toolbar, onReference } = await renderPanel(documents);
    await act(async () => reference().click());
    expect(onReference).toHaveBeenCalledWith(rules);
    ({ toolbar, onReference } = await renderPanel(documents, { referenced: "canvas/documents/rules.md" }));
    expect(reference().getAttribute("aria-pressed")).toBe("true");
    await act(async () => reference().click());
    expect(onReference).toHaveBeenCalledWith(undefined);
  });

  it("offers to write a document when there is none", async () => {
    const documents = documentsState([]);
    const { onAskAgent } = await renderPanel(documents);
    expect(container.textContent).toContain("This project has no game design document yet");
    const action = (name: string) => [...container.querySelectorAll<HTMLButtonElement>(".ui-empty button")].find((button) => button.textContent === name)!;
    await act(async () => action("Ask the agent to write one").click());
    expect(onAskAgent).toHaveBeenCalledWith(expect.stringContaining("game design document"));
    await act(async () => action("New document").click());
    expect(documents.create).toHaveBeenCalledOnce();
  });

  it("names a document it can't read instead of offering a new one, and keeps a conflict's choices", async () => {
    const documents = documentsState([]);
    documents.workspace!.documentIssues = [{ id: "rules", title: "Rules", source: "canvas/documents/rules.md", message: "ENOENT" }];
    await renderPanel(documents);
    expect(container.textContent).toContain("Rules: ");
    expect(container.textContent).toContain("canvas/documents/rules.md");
    expect(container.querySelector(".ui-empty")).toBeNull();
    expect(container.querySelector(".canvas-notice-close")).toBeNull();

    const conflicted = { ...documentsState([rules]), conflict: { local: rules } } as unknown as CanvasDocumentsState;
    await renderPanel(conflicted);
    expect(container.querySelector(".canvas-notice-close")).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".canvas-notice button")].find((button) => button.textContent === "Keep my version")!.click());
    expect(conflicted.resolve).toHaveBeenCalledWith("local");
  });

  it("doesn't load the documents, and so create the canvas, until a panel wants them", async () => {
    const load = vi.spyOn(canvasApi, "getCanvasWorkspace").mockResolvedValue({ version: 1, boards: [{ id: "main", name: "Main" }], documents: [], assets: [] });
    function Host({ enabled }: { enabled: boolean }) {
      useCanvasDocuments("project-1", enabled);
      return null;
    }
    await act(async () => root.render(<Host enabled={false} />));
    expect(load).not.toHaveBeenCalled();
    await act(async () => root.render(<Host enabled />));
    expect(load).toHaveBeenCalledWith("project-1");
  });
});
