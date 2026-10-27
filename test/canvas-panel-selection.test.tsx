// @vitest-environment happy-dom
import path from "node:path";
import { act, useContext } from "react";
import { CanvasInteractions } from "../src/renderer/canvas-node-interactions.js";
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
const captured = { props: undefined as CanvasProps | undefined, actions: undefined as React.ContextType<typeof CanvasInteractions> };
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: CanvasProps) => {
    captured.props = props;
    captured.actions = useContext(CanvasInteractions);
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
  listAudioModelCatalog: async () => ({ models: [], providers: [] }),
  listImageModelCatalog: async () => ({ models: [], providers: [] }),
  listVideoModelCatalog: async () => ({ models: [], providers: [] }),
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
  listModel3DOperations: async () => [],
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


it("selects and removes canvas references through the same semantic connection, then exits with Escape", async () => {
  await act(async () => captured.actions!.pickReferences("image"));
  expect(captured.props!.pickingReferences).toBe(true);
  expect(container.querySelector('.canvas-reference-mode [role="status"]')?.textContent).toBe("Select reference nodes");
  expect(flowNode("image").className).toBe("canvas-reference-target");
  expect(flowNode("image").ariaLabel).toBe("Image");
  expect(flowNode("text").className).toBe("canvas-reference-candidate");
  expect(flowNode("table").className).toBe("canvas-reference-unavailable");
  const clickText = () => captured.props!.onNodeClick!({ target: nodeElement("text") } as never, flowNode("text"));
  await act(async () => clickText());
  expect(flowNode("image").data.promptSource).toEqual({ type: "node", nodeId: "text" });
  expect(captured.props!.edges).toContainEqual(expect.objectContaining({ source: "text", target: "image" }));
  expect(flowNode("text").className).toBe("canvas-reference-selected");
  expect(container.querySelector(".canvas-reference-mode span")?.textContent).toBe("Click a node to add or remove it · 1 linked");
  expect(flowNode("image").selected).toBe(true);
  expect(flowNode("text").selected).toBe(false);
  await act(async () => clickText());
  expect(flowNode("image").data.promptSource).toBeUndefined();
  expect(captured.props!.edges).not.toContainEqual(expect.objectContaining({ source: "text", target: "image" }));
  await press(container.querySelector(".interactive-story-canvas")!, "Escape");
  expect(captured.props!.pickingReferences).toBe(false);
  expect(flowNode("image").selected).toBe(true);
  expect(flowNode("image").data.panelOpen).toBe(true);
});

it("creates a compatible continuation and undoes the node and reference together", async () => {
  const count = captured.props!.nodes.length;
  await act(async () => captured.actions!.openPort("text", "source", { x: 200, y: 200 }));
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "Image")!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  expect(captured.props!.nodes).toHaveLength(count + 1);
  const added = captured.props!.nodes.find((node) => node.id !== "image" && node.type === "image")!;
  expect(added.data.promptSource).toEqual({ type: "node", nodeId: "text" });
  expect(added.selected).toBe(true);
  expect(document.activeElement).toBe(container.querySelector(".interactive-story-canvas"));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  const canvas = container.querySelector(".interactive-story-canvas")!;
  await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
  expect(captured.props!.nodes).toHaveLength(count);
  expect(captured.props!.edges!.some((edge) => edge.target === added.id)).toBe(false);
  await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true })));
  expect(flowNode(added.id).data.promptSource).toEqual({ type: "node", nodeId: "text" });
});


it("restores the previous prompt source when undoing a context node created from an input", async () => {
  await act(async () => captured.props!.onConnect!({ source: "text", target: "image", sourceHandle: "out", targetHandle: null }));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  const count = captured.props!.nodes.length;
  await act(async () => captured.actions!.openPort("image", "target", { x: 200, y: 200 }));
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "Text")!;
  await act(async () => button.click());
  const newSource = captured.props!.nodes.find((node) => node.type === "text" && node.id !== "text")!;
  expect(flowNode("image").data.promptSource).toEqual({ type: "node", nodeId: newSource.id });
  await act(async () => vi.advanceTimersByTimeAsync(500));
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })));
  expect(captured.props!.nodes).toHaveLength(count);
  expect(flowNode("image").data.promptSource).toEqual({ type: "node", nodeId: "text" });
});


it("places a continuation below an occupied area while preserving grid alignment", async () => {
  await act(async () => captured.props!.onNodesChange!([
    { type: "position", id: "image", position: { x: 560, y: 0 } },
    { type: "dimensions", id: "image", dimensions: { width: 440, height: 401 } },
  ]));
  await act(async () => captured.actions!.openPort("text", "source", { x: 200, y: 200 }));
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === "Image")!;
  await act(async () => button.click());
  const added = captured.props!.nodes.find((node) => node.type === "image" && node.id !== "image")!;
  expect(added.position.x).toBe(560);
  expect(added.position.y).toBeGreaterThan(581);
  expect(added.position.y % 10).toBe(0);
  expect(added.data.promptSource).toEqual({ type: "node", nodeId: "text" });
});
