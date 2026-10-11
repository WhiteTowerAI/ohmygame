// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import type { ProjectState } from "../src/shared/contracts.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
} from "../src/shared/asset-canvas.js";

type CanvasProps = Parameters<typeof EditorCanvas<Node>>[0];
const captured = { props: undefined as CanvasProps | undefined };
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: CanvasProps) => {
    captured.props = props;
    return (
      <div>
        {props.nodes.map((node) => (
          <div
            key={node.id}
            className="react-flow__node"
            data-id={node.id}
            tabIndex={0}
          >
            <button type="button">Node action</button>
            <textarea aria-label={`${node.id} input`} />
          </div>
        ))}
      </div>
    );
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
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [],
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
  localStorage.clear();
  captured.props = undefined;
  const canvas = createAssetCanvasDocument();
  const position = { x: 0, y: 0 };
  canvas.nodes = [
    {
      id: "text",
      type: "text",
      position,
      data: { text: "Rules", instruction: "" },
    },
    ...(["image", "video", "model-3d"] as const).map((type) => ({
      ...createAssetGenerationNode(type, position),
      id: type,
    })),
    {
      id: "animate-3d",
      type: "animate-3d",
      position,
      data: { heightMeters: 1.7, actionIds: [1] },
    },
    { id: "document", type: "document", position, data: { documentId: "d" } },
    { id: "table", type: "table", position, data: { tableId: "t" } },
  ];
  canvas.editorLayout.nodes = Object.fromEntries(
    canvas.nodes.map((node) => [node.id, position]),
  );
  const storage: CanvasBoardStorage = {
    key: "p:b",
    boardId: "b",
    load: async () => structuredClone(canvas),
    save: async (value) => value,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
    jobs: async () => [],
    generate: async () => {
      throw new Error("Not used in selection tests");
    },
    cancel: async () => {
      throw new Error("Not used in selection tests");
    },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <CanvasBoardEditor
        project={{ id: "p", type: "web-game" } as ProjectState}
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flowNode = (id: string) =>
  captured.props!.nodes.find((node) => node.id === id)!;
const nodeElement = (id: string) =>
  container.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
async function select(ids: string[]) {
  await act(async () =>
    captured.props!.onNodesChange!(
      captured.props!.nodes.map((node) => ({
        type: "select",
        id: node.id,
        selected: ids.includes(node.id),
      })),
    ),
  );
}
async function marquee(ids: string[]) {
  await act(async () => captured.props!.onSelectionStart!({} as never));
  await select(ids);
  await act(async () => captured.props!.onSelectionEnd!({} as never));
}
async function press(target: HTMLElement, key: string) {
  await act(async () =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );
}

it.each(["Enter", " "])(
  "opens every node type after marquee selection and keyboard activation with %j",
  async (key) => {
    const ids = captured.props!.nodes.map((node) => node.id);
    await marquee(ids);
    expect(
      captured.props!.nodes.every(
        (node) => node.selected && !node.data.panelOpen,
      ),
    ).toBe(true);
    for (const id of ids) {
      await press(nodeElement(id), key);
      expect(flowNode(id).data.panelOpen).toBe(true);
    }
  },
);

it("keeps a single marquee node directly clickable and opens only its panel", async () => {
  await marquee(["image"]);
  expect(
    container
      .querySelector(".interactive-story-canvas")!
      .classList.contains("has-single-selection"),
  ).toBe(true);
  expect(flowNode("image").data.panelOpen).toBe(false);
  await act(async () =>
    captured.props!.onNodeClick!(
      { target: nodeElement("image") } as never,
      flowNode("image"),
    ),
  );
  expect(flowNode("image").data.panelOpen).toBe(true);
  expect(flowNode("video").data.panelOpen).toBe(false);

  await marquee(["image", "video"]);
  expect(
    container
      .querySelector(".interactive-story-canvas")!
      .classList.contains("has-single-selection"),
  ).toBe(false);
  expect(flowNode("image").data.panelOpen).toBe(false);
  expect(flowNode("video").data.panelOpen).toBe(false);
});

it("opens a marquee node selected through its context menu", async () => {
  await marquee(["image", "video"]);
  await act(async () =>
    captured.props!.onNodeContextMenu!({} as never, flowNode("image")),
  );
  expect(flowNode("image")).toMatchObject({
    selected: true,
    data: { panelOpen: true },
  });
  expect(flowNode("video").selected).toBe(false);
});

it("keeps panels closed through movement and clears the marquee mark after deselection", async () => {
  await marquee(["image", "video"]);
  await act(async () =>
    captured.props!.onNodesChange!([
      { type: "position", id: "image", position: { x: 40, y: 40 } },
    ]),
  );
  expect(flowNode("image")).toMatchObject({
    position: { x: 40, y: 40 },
    data: { panelOpen: false },
  });
  await select(["video"]);
  await select(["image", "video"]);
  expect(flowNode("image").data.panelOpen).toBe(true);
  expect(flowNode("video").data.panelOpen).toBe(false);
});

it("leaves Enter and Space in node controls to those controls", async () => {
  await marquee(["image"]);
  for (const target of nodeElement("image").querySelectorAll<HTMLElement>(
    "button, textarea",
  )) {
    await press(target, "Enter");
    await press(target, " ");
    expect(flowNode("image").data.panelOpen).toBe(false);
  }
});
