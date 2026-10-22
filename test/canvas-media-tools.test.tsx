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
const startTemplate = vi.fn();
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
  canvas.nodes = ["first", "second"].map((id, index) => ({
    id,
    type: "asset",
    position: { x: index * 600, y: index * 300 },
    data: { assetId: id, mediaType: "image", name: `${id}.png` },
  }));
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
        onStartTemplate={startTemplate}
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
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Rotate / mirror"]')!
      .click(),
  );
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
      operation: "transform-image",
      assetIds: ["first"],
      options: { rotate: 90, flip: false, flop: false, format: "png" },
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

it.each([
  ["Free sequence", "free-sequence"],
  ["Character action set", "action-set"],
])("opens the %s template with the selected image", async (label, template) => {
  await select("second");
  await act(async () => container.querySelector<HTMLButtonElement>(`[title="${label}"]`)!.click());
  expect(startTemplate).toHaveBeenCalledWith(template, "second");
  expect(captured.props!.nodes).toHaveLength(2);
  expect(generate).not.toHaveBeenCalled();
  expect(runMedia).not.toHaveBeenCalled();
});
