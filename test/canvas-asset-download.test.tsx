// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import type { PluginSlots } from "../src/renderer/project-plugin-contributions.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { CanvasAssetCatalogEntry } from "../src/shared/canvas-assets.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
} from "../src/shared/asset-canvas.js";
import { t } from "../src/renderer/i18n.js";

/** happy-dom lays nothing out and its observer never reports; here everything is on screen. */
class OnScreen {
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) { this.#callback = callback; }
  observe(target: Element) {
    queueMicrotask(() => this.#callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
  }
  disconnect() {}
}

type CanvasProps = Parameters<typeof EditorCanvas<Node>>[0];
let props: CanvasProps;
const getWorkspaceAsset = vi.fn(
  async (_projectId: string, filePath: string) =>
    new Blob(["media"], {
      type: assets.find((asset) => asset.path === filePath)!.contentType,
    }),
);
const getLibraryAsset = vi.fn(
  async () => new Blob(["library image"], { type: "image/png" }),
);
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (value: CanvasProps) => {
    props = value;
    return <div />;
  },
}));
// Viewers need WebGL; these tests only follow the files.
vi.doMock(path.resolve("src/renderer/model-preview.tsx"), () => ({
  ModelPreview: ({ source }: { source: string }) => <span data-model={source} />,
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
  listImageModelCatalog: async () => ({ models: [], providers: [] }),
  listVideoModelCatalog: async () => ({ models: [], providers: [] }),
  listAudioModelCatalog: async () => ({ models: [], providers: [] }),
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
  listModel3DOperations: async () => [],
  getWorkspaceAsset,
  getLibraryAsset,
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [
    {
      id: "library-image",
      assetId: "library-image",
      name: "output.png",
      path: "output.png",
      mediaType: "image",
      contentType: "image/png",
      size: 5,
      createdAt: "2026-10-23T00:00:00Z",
    },
  ],
}));
const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
const { CanvasAssetProvider, canvasAssetSources } =
  await import("../src/renderer/use-workspace-asset-url.js");
const { PluginSlotsContext } =
  await import("../src/renderer/project-plugin-contributions.js");
let pluginSlots: PluginSlots;
let root: ReturnType<typeof createRoot>,
  container: HTMLDivElement,
  downloads: string[];
const assets: CanvasAssetCatalogEntry[] = [
  {
    id: "image-output",
    name: "output.webp",
    path: "assets/imported/output.webp",
    mediaType: "image",
    contentType: "image/webp",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
  {
    id: "model-output",
    name: "model.glb",
    path: "assets/imported/model.glb",
    mediaType: "model",
    contentType: "model/gltf-binary",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
  {
    id: "video-output",
    name: "output.mp4",
    path: "assets/imported/output.mp4",
    mediaType: "video",
    contentType: "video/mp4",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
  {
    id: "audio-output",
    name: "output.wav",
    path: "assets/imported/output.wav",
    mediaType: "audio",
    contentType: "audio/wav",
    size: 5,
    createdAt: "2026-10-23T00:00:00Z",
  },
];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", OnScreen);
  localStorage.clear();
  getWorkspaceAsset.mockClear();
  getLibraryAsset.mockClear();
  downloads = [];
  pluginSlots = { commands: [], when: { values: {}, plugins: new Set() }, run: vi.fn(async () => undefined) };
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:canvas-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  const board = createAssetCanvasDocument(),
    position = { x: 0, y: 0 };
  const model = createAssetGenerationNode("model-3d", position);
  if (model.type !== "model-3d") throw new Error("Expected a model node");
  const video = createAssetGenerationNode("video", position);
  if (video.type !== "video") throw new Error("Expected a video node");
  board.nodes = [
    ...["小猫照片", "另一只猫", undefined].map((title, index) => {
      const node = createAssetGenerationNode("image", position);
      if (node.type !== "image") throw new Error("Expected an image node");
      return {
        ...node,
        id: `image-${index}`,
        title,
        data: { ...node.data, assetId: "image-output" },
      };
    }),
    {
      ...model,
      id: "model",
      title: "骑士 v1.2.glb",
      data: { ...model.data, assetId: "model-output" },
    },
    {
      ...video,
      id: "video",
      title: "片头",
      data: {
        ...video.data,
        assetId: "video-output",
      },
    },
    {
      id: "audio",
      type: "asset",
      position,
      title: "脚步声",
      data: { assetId: "audio-output", mediaType: "audio" },
    },
    {
      id: "library",
      type: "asset",
      position,
      title: "猫咪/正面",
      data: {
        assetId: "library-image",
        mediaType: "image",
      },
    },
  ];
  board.editorLayout.nodes = Object.fromEntries(
    board.nodes.map((node) => [node.id, position]),
  );
  const storage: CanvasBoardStorage = {
    key: "download:b",
    boardId: "b",
    load: async () => structuredClone(board),
    save: async (value) => value,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
    jobs: async () => [],
    generate: vi.fn(),
    cancel: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <PluginSlotsContext value={pluginSlots}>
        <CanvasAssetProvider assets={canvasAssetSources("download", assets)}>
          <CanvasBoardEditor
            project={{ id: "download", type: "web-game" } as ProjectState}
            storage={storage}
            documents={{ documents: [] } as unknown as CanvasDocuments}
            tables={{
              storage: new CanvasTableStorage("download"),
              open: vi.fn(),
              add: vi.fn(),
            }}
            assets={assets}
          />
        </CanvasAssetProvider>
      </PluginSlotsContext>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function clickNodeAction(nodeId: string, label: string): Promise<void> {
  await act(async () =>
    props.onOpenMenu({
      kind: "node",
      nodeId,
      screenPosition: { x: 0, y: 0 },
      flowPosition: { x: 0, y: 0 },
    }),
  );
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label)!;
  await act(async () => button.click());
}

async function openViewer(nodeId: string): Promise<void> {
  const target = document.createElement("button");
  target.className = "story-media-view-button";
  await act(async () =>
    props.onNodeClick!(
      { target } as never,
      props.nodes.find((node) => node.id === nodeId)!,
    ),
  );
}

it.each([
  ["image-0", "小猫照片.webp", "assets/imported/output.webp"],
  ["image-1", "另一只猫.webp", "assets/imported/output.webp"],
  ["image-2", "output.webp", "assets/imported/output.webp"],
  ["model", "骑士 v1.2.glb", "assets/imported/model.glb"],
  ["video", "片头.mp4", "assets/imported/output.mp4"],
  ["library", "猫咪正面.png", undefined],
])(
  "uses the same filename from the context menu and viewer for %s",
  async (nodeId, filename, source) => {
    await clickNodeAction(nodeId, t("assetCanvas.download"));
    expect(downloads).toEqual([filename]);

    await openViewer(nodeId);
    expect(
      document.getElementById("canvas-asset-viewer-title")?.textContent,
    ).toBe(filename);
    const viewerDownload = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("assetCanvas.downloadName", { name: filename })}"]`,
    )!;
    await act(async () => viewerDownload.click());
    expect(downloads).toEqual([filename, filename]);
    if (source)
      expect(getWorkspaceAsset).toHaveBeenLastCalledWith("download", source);
    else expect(getLibraryAsset).toHaveBeenLastCalledWith("library-image");
    expect(assets.map((asset) => asset.name)).toEqual([
      "output.webp",
      "model.glb",
      "output.mp4",
      "output.wav",
    ]);
  },
);

it("uses the audio node title when downloading from its context menu", async () => {
  await clickNodeAction("audio", t("assetCanvas.download"));
  expect(downloads).toEqual(["脚步声.wav"]);
  expect(getWorkspaceAsset).toHaveBeenLastCalledWith(
    "download",
    "assets/imported/output.wav",
  );
});

it("keeps the viewed output extension when a node receives a new asset", async () => {
  await openViewer("image-0");
  const node = props.nodes.find((item) => item.id === "image-0")!;
  await act(async () =>
    props.onNodesChange!([
      {
        type: "replace",
        id: node.id,
        item: { ...node, data: { ...node.data, assetId: "library-image" } },
      },
    ]),
  );
  const filename = "小猫照片.webp";
  expect(
    document.getElementById("canvas-asset-viewer-title")?.textContent,
  ).toBe(filename);
  const download = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${t("assetCanvas.downloadName", { name: filename })}"]`,
  )!;
  await act(async () => download.click());
  expect(downloads).toEqual([filename]);
  expect(getWorkspaceAsset).toHaveBeenLastCalledWith(
    "download",
    "assets/imported/output.webp",
  );
});

it("downloads the current title after renaming a node and falls back when cleared", async () => {
  for (const [title, filename] of [
    ["更新后的猫咪", "更新后的猫咪.webp"],
    ["FooBar-Cat_01", "FooBar-Cat_01.webp"],
    ["", "output.webp"],
  ]) {
    await clickNodeAction("image-0", t("assetCanvas.nodeDetails"));
    const input = document.querySelector<HTMLInputElement>(
      ".design-modal input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, title);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await openViewer("image-0");
    expect(
      document.getElementById("canvas-asset-viewer-title")?.textContent,
    ).toBe(filename);
    const download = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("assetCanvas.downloadName", { name: filename! })}"]`,
    )!;
    await act(async () => download.click());
    expect(downloads.at(-1)).toBe(filename);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${t("assets.closePreview")}"]`,
        )!
        .click(),
    );
  }
});

async function renderNode(nodeId: string, catalog = assets, data?: Record<string, unknown>, type?: string) {
  const { ReactFlowProvider } = await import("@xyflow/react");
  const node = props.nodes.find((item) => item.id === nodeId)!;
  const Component = props.nodeTypes![type ?? node.type!] as unknown as (value: { data: unknown; selected: boolean }) => React.ReactNode;
  const host = document.createElement("div");
  document.body.append(host);
  const nodeRoot = createRoot(host);
  await act(async () => nodeRoot.render(
    <ReactFlowProvider>
      <CanvasAssetProvider assets={canvasAssetSources("download", catalog)}>
        <Component data={{ ...node.data, ...data }} selected={false} />
      </CanvasAssetProvider>
    </ReactFlowProvider>,
  ));
  return { host, unmount: async () => { await act(async () => nodeRoot.unmount()); host.remove(); } };
}

it("downloads a node's file only once the node comes near the screen", async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  const node = await renderNode("image-0");
  expect(getWorkspaceAsset).not.toHaveBeenCalled();
  await act(async () => observers.at(-1)!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith("download", "assets/imported/output.webp");
  await node.unmount();
});

it("waits for the person before it downloads a large 3D file", async () => {
  const large = assets.map((asset) => asset.id === "model-output" ? { ...asset, size: 100 * 1024 * 1024 } : asset);
  // An imported model is an asset node.
  const node = await renderNode("library", large, { assetId: "model-output", mediaType: "model" });
  expect(getWorkspaceAsset).not.toHaveBeenCalled();
  expect(node.host.textContent).toContain(t("assetCanvas.largeModel", { size: "100.0 MB" }));
  const load = [...node.host.querySelectorAll("button")].find((button) => button.textContent === t("assetCanvas.loadModel"))!;
  await act(async () => load.click());
  expect(getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith("download", "assets/imported/model.glb");
  await node.unmount();
});

it("waits for the person while a 3D file's size isn't known yet", async () => {
  // Just added from the Library: in neither the project's assets nor the loaded Library list.
  const node = await renderNode("library", assets, { assetId: "new-model", mediaType: "model", assetSize: undefined });
  expect(getLibraryAsset).not.toHaveBeenCalled();
  const load = [...node.host.querySelectorAll("button")].find((button) => button.textContent === t("assetCanvas.loadModel"))!;
  await act(async () => load.click());
  expect(getLibraryAsset).toHaveBeenCalledExactlyOnceWith("new-model");
  await node.unmount();
});

it("keeps a plugin node's large 3D output waiting for the person", async () => {
  const large = assets.map((asset) => asset.id === "model-output" ? { ...asset, size: 100 * 1024 * 1024 } : asset);
  const node = await renderNode("library", large, { assetId: "model-output", pluginRuntime: { output: "model", sources: {} } }, "plugin");
  expect(getWorkspaceAsset).not.toHaveBeenCalled();
  const load = [...node.host.querySelectorAll("button")].find((button) => button.textContent === t("assetCanvas.loadModel"))!;
  await act(async () => load.click());
  expect(getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith("download", "assets/imported/model.glb");
  await node.unmount();
});

// Both menu changes must survive: grouped built-in actions and plugin node commands.
it("runs a plugin action for the selected node alongside grouped copy and download actions", async () => {
  const command = {
    id: "test/media:inspect",
    plugin: "test/media",
    title: "Inspect image",
    slots: [{ slot: "canvas.node" }],
    run: { native: "inspect", input: "node" },
  };
  pluginSlots.commands = [command];
  await act(async () => props.onOpenMenu({
    kind: "node", nodeId: "image-0",
    screenPosition: { x: 0, y: 0 }, flowPosition: { x: 0, y: 0 },
  }));
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const copy = items.find((item) => item.querySelector("span")?.textContent === t("assetCanvas.copyNode"))!;
  expect(copy.querySelector("kbd")?.textContent).toBeTruthy();
  expect(items.some((item) => item.textContent === t("assetCanvas.download"))).toBe(true);
  const action = items.find((item) => item.textContent === command.title)!;
  expect(action.previousElementSibling?.getAttribute("role")).toBe("separator");
  expect(action.nextElementSibling?.getAttribute("role")).toBe("separator");
  expect(action.nextElementSibling?.nextElementSibling?.textContent).toContain(t("common.delete"));
  await act(async () => action.click());
  expect(pluginSlots.run).toHaveBeenCalledExactlyOnceWith(command, {
    input: { boardId: "b", nodeId: "image-0", nodeType: "image", assetId: "image-output" },
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
