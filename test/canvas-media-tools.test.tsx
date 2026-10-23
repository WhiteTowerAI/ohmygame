// @vitest-environment happy-dom
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Node } from "@xyflow/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import type { ImageModel, ProjectState, ToolJob } from "../src/shared/contracts.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { LibraryAsset } from "../src/renderer/library-assets.js";

const captured = {
  props: undefined as Parameters<typeof EditorCanvas<Node>>[0] | undefined,
};
const viewport = { x: 0, y: 100, zoom: 1 };
const setCenter = vi.fn();
const runMedia = vi.fn();
const loadAssets = vi.fn(async (): Promise<LibraryAsset[]> => []);
const save = vi.fn(async (value) => value);
const imageModels: ImageModel[] = [];
const generate = vi.fn(async (): Promise<ToolJob> => ({ id: "generated-job", toolId: "generate-image", createdAt: new Date().toISOString(), status: "running", title: "Actions" }));
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: Parameters<typeof EditorCanvas<Node>>[0]) => {
    captured.props = props;
    return <div>{props.children}</div>;
  },
}));
vi.doMock("@xyflow/react", async (original) => ({
  ...(await original<typeof import("@xyflow/react")>()),
  useViewport: () => viewport,
  NodeToolbar: ({
    nodeId,
    offset,
    position,
    children,
  }: {
    nodeId: string;
    offset: number;
    position: string;
    children: ReactNode;
  }) => (
    <div
      data-toolbar-node={nodeId}
      data-offset={offset}
      data-position={position}
    >
      {children}
    </div>
  ),
}));
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/canvas-api.js")>()),
  runCanvasMedia: runMedia,
}));
vi.doMock(
  path.resolve("src/renderer/model-selector.tsx"),
  async (original) => ({
    ...(await original<typeof import("../src/renderer/model-selector.js")>()),
    useAgentModels: () => ({ models: [], status: "ready" }),
  }),
);
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listImageModelCatalog: async () => ({ models: imageModels, providers: [] }),
  listVideoModelCatalog: async () => ({ models: [], providers: [] }),
  listAudioModelCatalog: async () => ({ models: [], providers: [] }),
  getProjectCover: async () => new Blob(),
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
  listModel3DOperations: async () => [],
  getLibraryAsset: async () => new Blob(),
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: loadAssets,
}));
const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  runMedia.mockReset();
  loadAssets.mockResolvedValue([]);
  imageModels.length = 0;
  imageModels.push({ provider: "google", id: "image-ref", name: "Reference image", providerName: "Google", sizes: ["1024x1024"], generationOptions: [{ resolution: "1K", aspectRatio: "1:1" }, { resolution: "1K", aspectRatio: "4:3" }], supportsReferenceImage: true, maxReferenceImages: 4, maxOutputs: 1, protocol: "gemini-generate-content" });
  Object.assign(viewport, { x: 0, y: 100, zoom: 1 });
  const canvas = createAssetCanvasDocument();
  canvas.nodes = [
    { id: "first", type: "asset" as const, position: { x: 0, y: 0 }, data: { assetId: "first", mediaType: "image" as const } },
    { id: "second", type: "image" as const, position: { x: 600, y: 300 }, data: { assetId: "second", prompt: "second", resolution: "1K" as const, aspectRatio: "1:1" as const, images: [] } },
  ];
  canvas.editorLayout.nodes = Object.fromEntries(
    canvas.nodes.map((node) => [node.id, node.position]),
  );
  const storage: CanvasBoardStorage = {
    key: "p:b",
    boardId: "b",
    load: async () => structuredClone(canvas),
    save,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
    jobs: async () => [],
    generate,
    cancel: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CanvasBoardEditor
        project={{ id: "p", type: "asset-canvas" } as ProjectState}
        storage={storage}
        documents={{ documents: [] } as unknown as CanvasDocuments}
        tables={{
          storage: new CanvasTableStorage("p"),
          open: vi.fn(),
          add: vi.fn(),
        }}
        assets={[]}
      />,
    ),
  );
  await act(async () =>
    captured.props!.onInit!({
      setCenter,
      getViewport: () => viewport,
    } as never),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function select(id: string) {
  await act(async () =>
    captured.props!.onNodesChange!(
      captured.props!.nodes.map((node) => ({
        type: "select",
        id: node.id,
        selected: node.id === id,
      })),
    ),
  );
}
async function openTool() {
  await select("first");
  await chooseTool("Image tools", "AI cutout");
}
async function chooseTool(category: string, label: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(`.asset-media-toolbar > .asset-media-toolbar-group > [aria-label="${category}"]`)!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label)!.click());
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
function outputAsset(id: string): LibraryAsset {
  return {
    id,
    assetId: id,
    name: `${id}.png`,
    path: `${id}.png`,
    mediaType: "image",
    contentType: "image/png",
    size: 100,
    createdAt: new Date().toISOString(),
  } as LibraryAsset;
}

it("anchors to the newly selected node with a constant screen offset across zoom and pan", async () => {
  Object.assign(viewport, { y: 300 });
  await select("first");
  expect(
    container
      .querySelector("[data-toolbar-node]")
      ?.getAttribute("data-toolbar-node"),
  ).toBe("first");
  expect(
    container.querySelector("[data-toolbar-node]")?.getAttribute("data-offset"),
  ).toBe("10");
  expect(
    container
      .querySelector("[data-toolbar-node]")
      ?.getAttribute("data-position"),
  ).toBe("top");
  Object.assign(viewport, { zoom: 0.5, y: -200 });
  await select("second");
  expect(
    container
      .querySelector("[data-toolbar-node]")
      ?.getAttribute("data-toolbar-node"),
  ).toBe("second");
  expect(
    container.querySelector("[data-toolbar-node]")?.getAttribute("data-offset"),
  ).toBe("10");
  expect(
    container
      .querySelector("[data-toolbar-node]")
      ?.getAttribute("data-position"),
  ).toBe("bottom");
});

it("shows only categories until opened, including GIF and frame actions on generated images", async () => {
  await select("second");
  expect(container.querySelectorAll(".asset-media-toolbar > .asset-media-toolbar-group")).toHaveLength(3);
  expect(container.querySelector('[aria-label="Character actions"]')).toBeNull();
  expect(container.querySelector('[role="menuitem"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="GIF & merging"]')!.click());
  expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
    "Extract GIF frames", "Compose GIF", "Compose video", "Compose layers",
  ]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Image tools"]')!.click());
  expect([...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["AI cutout", "Crop image"]);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[role="menuitem"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="GIF & merging"]')!.click());
  await select("first");
  expect(container.querySelector('[role="menuitem"]')).toBeNull();
});

it("opens categories on hover and disables every multi-image tool for one image", async () => {
  await select("first");
  const gifCategory = container.querySelector<HTMLButtonElement>('[aria-label="GIF & merging"]')!;
  await act(async () => gifCategory.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(gifCategory.getAttribute("aria-expanded")).toBe("true");
  for (const label of ["Compose GIF", "Compose video", "Compose layers", "Extract GIF frames"]) {
    const item = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label)!;
    expect(item.disabled).toBe(true);
    await act(async () => item.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  }
  const processingCategory = container.querySelector<HTMLButtonElement>('[aria-label="Image tools"]')!;
  await act(async () => processingCategory.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(gifCategory.getAttribute("aria-expanded")).toBe("false");
  await act(async () => captured.props!.onNodesChange!(captured.props!.nodes.map((node) => ({ type: "select", id: node.id, selected: true }))));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="GIF & merging"]')!.click());
  expect([...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "Compose GIF")?.disabled).toBe(false);
});

it("shows only the frame-strip button for a selected video", async () => {
  await act(async () => captured.props!.onNodesChange!([{
    type: "add",
    item: { id: "video", type: "asset", position: { x: 0, y: 600 }, data: { assetId: "video", mediaType: "video" } },
  }]));
  await select("video");
  expect(container.querySelectorAll(".asset-media-toolbar-button")).toHaveLength(1);
  const button = container.querySelector<HTMLButtonElement>(".asset-media-toolbar-button")!;
  expect(button.textContent).toBe("Pull frame strip");
  expect(container.textContent).not.toContain("Extract video frames");
  await act(async () => button.click());
  expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Pull frame strip");
});

it("previews image grid boundaries without frame-selection controls", async () => {
  await select("first");
  await chooseTool("Grid split", "4 cells (2 × 2)");
  expect(container.querySelectorAll(".asset-media-grid-line")).toHaveLength(2);
  expect(container.querySelector(".asset-video-frame-editor")).toBeNull();
  runMedia.mockRejectedValue(new Error("Keep dialog open"));
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", {
    operation: "split-image-grid", assetIds: ["first"],
    options: { columns: 2, rows: 2, format: "png" },
  });
});

it("selects video frames while previewing the source video", async () => {
  await act(async () => captured.props!.onNodesChange!([{
    type: "add",
    item: { id: "video", type: "asset", position: { x: 0, y: 600 }, data: { assetId: "video", mediaType: "video" } },
  }]));
  await select("video");
  await act(async () => container.querySelector<HTMLButtonElement>(".asset-media-toolbar-button")!.click());
  const video = container.querySelector<HTMLVideoElement>(".asset-video-frame-editor video")!;
  expect(video).not.toBeNull();
  Object.defineProperty(video, "duration", { value: 1 });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
  expect(container.querySelectorAll(".asset-video-frame-strip button")).toHaveLength(8);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Frame 2"]')!.click());
  expect(container.querySelector('[aria-label="Frame 2"]')?.getAttribute("aria-pressed")).toBe("false");
  runMedia.mockRejectedValue(new Error("Keep dialog open"));
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", {
    operation: "video-frame-strip", assetIds: ["video"],
    options: { fps: 8, startTime: 0, duration: undefined, format: "png", selectedFrames: [0, 2, 3, 4, 5, 6, 7] },
  });
});

it("extracts the full range when the browser cannot preview a video", async () => {
  await act(async () => captured.props!.onNodesChange!([{
    type: "add",
    item: { id: "video", type: "asset", position: { x: 0, y: 600 }, data: { assetId: "video", mediaType: "video" } },
  }]));
  await select("video");
  await act(async () => container.querySelector<HTMLButtonElement>(".asset-media-toolbar-button")!.click());
  await act(async () => container.querySelector<HTMLVideoElement>(".asset-video-frame-editor video")!.dispatchEvent(new Event("error")));
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("cannot be previewed");
  expect(container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(false);
  runMedia.mockRejectedValue(new Error("Keep dialog open"));
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", {
    operation: "video-frame-strip", assetIds: ["video"],
    options: { fps: 8, startTime: 0, duration: undefined, format: "png" },
  });
});

it("composes selected images using the edited layer order", async () => {
  await act(async () => captured.props!.onNodesChange!(captured.props!.nodes.map((node) => ({ type: "select", id: node.id, selected: true }))));
  await chooseTool("GIF & merging", "Compose layers");
  const firstImage = container.querySelector<HTMLImageElement>(".asset-layer-stage-image")!;
  Object.defineProperties(firstImage, { naturalWidth: { value: 64 }, naturalHeight: { value: 32 } });
  await act(async () => firstImage.dispatchEvent(new Event("load")));
  const fields = container.querySelectorAll<HTMLInputElement>(".asset-media-tool-grid input");
  expect([fields[0]?.value, fields[1]?.value]).toEqual(["64", "32"]);
  container.querySelector<HTMLElement>(".asset-layer-stage")!.getBoundingClientRect = () => ({ width: 320, height: 160 }) as DOMRect;
  firstImage.setPointerCapture = vi.fn();
  await act(async () => {
    firstImage.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 10, clientY: 10 }));
    firstImage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 26, clientY: 26 }));
    firstImage.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  });
  await act(async () => container.querySelectorAll<HTMLButtonElement>('.asset-layer-heading [aria-label="Move earlier"]')[1]!.click());
  runMedia.mockRejectedValue(new Error("Keep dialog open"));
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", {
    operation: "compose-image-layers", assetIds: ["second", "first"],
    options: { width: 64, height: 32, layers: [
      { x: 0, y: 0, scale: 1, opacity: 1, visible: true },
      { x: 3, y: 3, scale: 1, opacity: 1, visible: true },
    ] },
  });
});

it.each([1, 4])(
  "creates, selects, reveals, and saves all %i returned result nodes",
  async (count) => {
    const assets = Array.from({ length: count }, (_, index) =>
      outputAsset(`result-${index}`),
    );
    loadAssets.mockResolvedValue(assets);
    const results = assets.map((asset) => ({
      assetId: asset.id,
      name: asset.name,
      mediaType: asset.mediaType,
    }));
    runMedia.mockResolvedValue(
      count === 1
        ? { kind: "asset", ...results[0] }
        : { kind: "assets", assets: results },
    );
    await openTool();
    await submit();
    expect(runMedia).toHaveBeenCalledWith("p", {
      operation: "ai-cutout",
      assetIds: ["first"],
      options: {},
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(captured.props!.nodes).toHaveLength(2 + count);
    expect(
      captured
        .props!.nodes.filter((node) => node.selected)
        .map((node) => node.data.assetId),
    ).toEqual(assets.map((asset) => asset.id));
    expect(setCenter).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(400));
    expect(save.mock.calls.at(-1)![0].nodes).toHaveLength(2 + count);
  },
);

it("passes the reordered selection to GIF composition", async () => {
  await act(async () => captured.props!.onNodesChange!(captured.props!.nodes.map((node) => ({ type: "select", id: node.id, selected: true }))));
  runMedia.mockRejectedValue(new Error("Keep order for retry"));
  await chooseTool("GIF & merging", "Compose GIF");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Move later"]:not(:disabled)')!.click());
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", { operation: "compose-gif", assetIds: ["second", "first"], options: { fps: 8 } });
});

it("shows processing and failures inside the dialog, and allows retry", async () => {
  let reject!: (error: Error) => void;
  runMedia.mockImplementationOnce(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  await openTool();
  await submit();
  expect(
    container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
  ).toBe(true);
  expect(container.querySelector('[type="submit"]')!.textContent).toContain(
    "Processing",
  );
  await act(async () => reject(new Error("Could not process image")));
  expect(
    container.querySelector('[role="dialog"] [role="alert"]')?.textContent,
  ).toBe("Could not process image");
  expect(
    container.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled,
  ).toBe(false);
  expect(captured.props!.nodes).toHaveLength(2);
  const result = outputAsset("retry-result");
  loadAssets.mockResolvedValue([result]);
  runMedia.mockResolvedValue({ kind: "asset", assetId: result.id });
  await submit();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(captured.props!.nodes).toHaveLength(3);
});

it("enables GIF extraction only for a single GIF node", async () => {
  await act(async () => captured.props!.onNodesChange!([{ type: "add", item: { id: "gif", type: "asset", position: { x: 0, y: 600 }, data: { assetId: "gif", mediaType: "image", contentType: "image/gif" } } }]));
  await select("gif");
  await chooseTool("GIF & merging", "Extract GIF frames");
  expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Extract GIF frames");
  runMedia.mockRejectedValue(new Error("Keep dialog open"));
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", { operation: "extract-gif-frames", assetIds: ["gif"], options: {} });
});

it.each([3, 4, 5])("previews and submits the %i by %i grid preset", async (side) => {
  await select("first");
  await chooseTool("Grid split", `${side * side} cells (${side} × ${side})`);
  expect(container.querySelectorAll(".asset-media-grid-line")).toHaveLength((side - 1) * 2);
  runMedia.mockRejectedValue(new Error("Keep dialog open"));
  await submit();
  expect(runMedia).toHaveBeenCalledWith("p", { operation: "split-image-grid", assetIds: ["first"], options: { columns: side, rows: side, format: "png" } });
});

it("chooses a custom grid with a highlighted cell picker", async () => {
  await select("first");
  await chooseTool("Grid split", "Other…");
  const cell = container.querySelector<HTMLButtonElement>('.asset-grid-picker [aria-label="3 × 2"]')!;
  await act(async () => cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(container.querySelectorAll(".asset-grid-picker .is-active")).toHaveLength(6);
  await act(async () => cell.click());
  const fields = container.querySelectorAll<HTMLInputElement>(".asset-media-tool-grid input");
  expect([fields[0]?.value, fields[1]?.value]).toEqual(["3", "2"]);
});

async function cropEditor(width = 250, height = 500) {
  await select("first");
  const node = document.createElement("div");
  node.className = "react-flow__node";
  node.dataset.id = "first";
  node.innerHTML = '<div class="story-media-stage"><img alt="source" /></div>';
  container.append(node);
  const image = node.querySelector("img")!;
  Object.defineProperties(node.querySelector(".story-media-stage")!, { clientWidth: { value: width }, clientHeight: { value: height } });
  Object.defineProperties(image, { naturalWidth: { value: 1000 }, naturalHeight: { value: 2000 } });
  await chooseTool("Image tools", "Crop image");
  const editor = container.querySelector<SVGSVGElement>(".asset-inline-crop")!;
  expect(editor.parentElement).toBe(node.querySelector(".story-media-stage"));
  editor.getBoundingClientRect = () => ({ left: 10, top: 20, width: 250, height: 500 }) as DOMRect;
  editor.setPointerCapture = vi.fn();
  return editor;
}
function pointer(editor: Element, type: string, clientX: number, clientY: number) {
  editor.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX, clientY, pointerId: 1, button: 0 }));
}

it("crops the original tall image in source pixels at a scaled viewport", async () => {
  const editor = await cropEditor();
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => {
    pointer(editor, "pointerdown", 35, 70);
    pointer(editor, "pointermove", 235, 470);
    pointer(editor, "pointerup", 235, 470);
  });
  runMedia.mockRejectedValue(new Error("Retry crop"));
  await act(async () => container.querySelector<HTMLButtonElement>(".asset-crop-confirm")!.click());
  expect(runMedia).toHaveBeenCalledWith("p", { operation: "crop-image", assetIds: ["first"], options: { left: 100, top: 200, width: 800, height: 1600, format: "png" } });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Retry crop");
});

it("places the crop overlay over the image content inside a letterboxed stage", async () => {
  const editor = await cropEditor(400, 500);
  expect(editor.style.left).toBe("75px");
  expect(editor.style.top).toBe("0px");
  expect(editor.style.width).toBe("250px");
  expect(editor.style.height).toBe("500px");
});

it("constrains crop proportions, resizes a corner, and cancels with Escape", async () => {
  const editor = await cropEditor();
  const aspect = container.querySelector<HTMLSelectElement>('select[aria-label="Aspect ratio"]')!;
  await act(async () => { aspect.value = "1"; aspect.dispatchEvent(new Event("change", { bubbles: true })); });
  const selection = editor.querySelector(".asset-inline-crop-selection")!;
  expect(selection.getAttribute("width")).toBe("1000");
  expect(selection.getAttribute("height")).toBe("1000");
  await act(async () => {
    pointer(editor.querySelector('[data-handle="se"]')!, "pointerdown", 260, 395);
    pointer(editor, "pointermove", 210, 345);
    pointer(editor, "pointerup", 210, 345);
  });
  expect(selection.getAttribute("width")).toBe(selection.getAttribute("height"));
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector(".asset-inline-crop")).toBeNull();
  expect(runMedia).not.toHaveBeenCalled();
});

it("cancels the inline crop when another node is selected", async () => {
  await cropEditor();
  await select("second");
  expect(container.querySelector(".asset-inline-crop")).toBeNull();
  expect(container.querySelector('[data-toolbar-node="second"]')).not.toBeNull();
});
