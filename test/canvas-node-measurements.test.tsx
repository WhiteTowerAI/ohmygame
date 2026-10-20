// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Node, ReactFlowInstance } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import type {
  AssetCanvasDocument,
  ProjectState,
} from "../src/shared/contracts.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import { mergeCanvasDocument } from "../src/shared/canvas-workspace.js";

type CanvasProps = Parameters<typeof EditorCanvas<Node>>[0];
let props: CanvasProps;
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (value: CanvasProps) => {
    props = value;
    return <div />;
  },
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
  uploadLibraryAsset: async () => ({
    id: "upload",
    name: "reference.png",
    mediaType: "image",
    contentType: "image/png",
    size: 100,
    createdAt: new Date().toISOString(),
  }),
  getProjectCover: async () => new Blob(),
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [],
}));

const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasTableStorage } =
  await import("../src/renderer/canvas-table-storage.js");
const save = vi.fn(async (canvas: AssetCanvasDocument) => canvas);
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let resolveConflict!: (version: "local" | "remote") => Promise<void>;
let remote: AssetCanvasDocument;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const board = createAssetCanvasDocument();
  board.nodes = [
    {
      id: "text",
      type: "text",
      position: { x: 600, y: 0 },
      data: { text: "", instruction: "" },
    },
  ];
  save.mockReset().mockImplementation(async (canvas) => canvas);
  const storage: CanvasBoardStorage = {
    key: "p:b",
    boardId: "b",
    load: async () => board,
    save,
    refresh: async () => undefined,
    reconcile: (submitted, current, saved) =>
      mergeCanvasDocument(submitted, current, saved)!,
    resolveConflict: async () => remote,
    jobs: async () => [],
    generate: vi.fn(),
    cancel: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
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
        onResolveReady={(value) => {
          if (value) resolveConflict = value;
        }}
      />,
    ),
  );
  props.onInit!({
    screenToFlowPosition: (point) => point,
  } as ReactFlowInstance);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function dropImage() {
  const file = new File(["image"], "reference.png", { type: "image/png" });
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], items: [], files: [file] },
  });
  Object.defineProperties(event, {
    clientX: { value: 0 },
    clientY: { value: 0 },
  });
  await act(async () => {
    container.querySelector(".interactive-story-canvas")!.dispatchEvent(event);
  });
  const source = props.nodes.find((node) => node.type === "asset")!;
  expect(source).toBeDefined();
  expect(source.measured).toEqual({});
  await act(async () =>
    props.onNodesChange!([
      {
        type: "dimensions",
        id: source.id,
        dimensions: { width: 440, height: 358 },
      },
      {
        type: "dimensions",
        id: "text",
        dimensions: { width: 300, height: 190 },
      },
    ]),
  );
  return source.id;
}

it("keeps imported image handles initialized when autosave reconciles a server update", async () => {
  // A concurrent server change forces reconciliation after the image is measured.
  save.mockImplementation(async (canvas) => ({
    ...canvas,
    nodes: canvas.nodes.map((node) => ({ ...node, title: "Saved title" })),
  }));
  const source = await dropImage();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(save).toHaveBeenCalled();
  expect(props.nodes.find((node) => node.id === source)).toMatchObject({
    title: "Saved title",
  });
  // React Flow clears its handle bounds if a mounted node loses measured.
  expect(props.nodes.find((node) => node.id === source)?.measured).toEqual({
    width: 440,
    height: 358,
  });
  expect(props.nodes.find((node) => node.id === source)?.selected).toBe(true);
  expect(props.nodes.find((node) => node.id === "text")?.measured).toEqual({
    width: 300,
    height: 190,
  });
  const connection = {
    source,
    target: "text",
    sourceHandle: "out",
    targetHandle: "references",
  };
  expect(props.isValidConnection!(connection)).toBe(true);
  await act(async () => props.onConnect!(connection));
  expect(props.edges).toContainEqual(expect.objectContaining(connection));
  expect(
    save.mock.lastCall![0].nodes.every((node) => !("measured" in node)),
  ).toBe(true);
});

it("keeps mounted node measurements when applying a remote document with a new explicit size", async () => {
  const source = await dropImage();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  remote = structuredClone(save.mock.lastCall![0]);
  remote.nodes = remote.nodes.map((node) =>
    node.id === "text" ? { ...node, width: 500, height: 250 } : node,
  );
  await act(async () => resolveConflict("remote"));
  expect(props.nodes.find((node) => node.id === source)?.measured).toEqual({
    width: 440,
    height: 358,
  });
  expect(props.nodes.find((node) => node.id === "text")).toMatchObject({
    width: 500,
    height: 250,
    measured: { width: 300, height: 190 },
  });
  // A real resize observation then replaces the old measurement.
  await act(async () =>
    props.onNodesChange!([
      {
        type: "dimensions",
        id: "text",
        dimensions: { width: 500, height: 250 },
      },
    ]),
  );
  expect(props.nodes.find((node) => node.id === "text")?.measured).toEqual({
    width: 500,
    height: 250,
  });
});
