// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import type {
  AssetCanvasDocument,
  AssetCanvasNode,
  ProjectState,
} from "../src/shared/contracts.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
  isAssetCanvasDocument,
} from "../src/shared/asset-canvas.js";
import { MAX_ASSET_CANVAS_NODES } from "../src/shared/asset-canvas-schema.js";

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
          />
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

/** A board where every node is connected through edges, references, prompt sources, or Library resources. */
function connectedBoard(): AssetCanvasDocument {
  const canvas = createAssetCanvasDocument();
  const image = createAssetGenerationNode("image", { x: 400, y: 0 });
  const video = createAssetGenerationNode("video", { x: 800, y: 0 });
  canvas.nodes = [
    {
      id: "prompt",
      type: "text",
      position: { x: 0, y: 0 },
      data: { text: "A hero", instruction: "" },
    },
    {
      id: "art",
      type: "asset",
      position: { x: 0, y: 300 },
      data: { assetId: "art-asset", mediaType: "image" },
    },
    {
      ...image,
      id: "image",
      title: "Hero shot",
      data: {
        ...image.data,
        prompt: "castle",
        promptSource: { type: "node", nodeId: "prompt" },
        images: [
          { type: "node", nodeId: "art" },
          { type: "library", assetId: "lib-ref" },
        ],
        assetId: "generated",
      },
    } as AssetCanvasNode,
    {
      ...video,
      id: "video",
      data: {
        ...video.data,
        prompt: "@Image1 runs past @Image2",
        promptSource: { type: "node", nodeId: "prompt" },
        references: [
          { type: "node", nodeId: "image" },
          { type: "library", assetId: "lib-frame" },
        ],
        referenceMentions: {
          Image1: { type: "node", nodeId: "image" },
          Image2: { type: "library", assetId: "lib-frame" },
        },
      },
    } as AssetCanvasNode,
    {
      id: "notes",
      type: "text",
      position: { x: 400, y: 400 },
      data: {
        text: "",
        instruction: "Summarize",
        references: [{ type: "node", nodeId: "image" }],
      },
    },
  ];
  canvas.edges = [{ id: "story-edge", source: "prompt", target: "art" }];
  canvas.editorLayout.nodes = Object.fromEntries(
    canvas.nodes.map((node) => [node.id, node.position]),
  );
  return canvas;
}
const original = (id: string) =>
  connectedBoard().nodes.find((node) => node.id === id)!;

const save = vi.fn(async (value: AssetCanvasDocument) => value);
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
async function mount(board: AssetCanvasDocument) {
  captured.props = undefined;
  const storage: CanvasBoardStorage = {
    key: "p:b",
    boardId: "b",
    load: async () => structuredClone(board),
    save,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
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
      />,
    ),
  );
  await settle();
  save.mockClear();
}
async function unmount() {
  await act(async () => root.unmount());
  container.remove();
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  save.mockReset().mockImplementation(async (value) => value);
  await mount(connectedBoard());
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ORIGINAL_IDS = ["prompt", "art", "image", "video", "notes"];
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
const flowNode = (id: string) =>
  captured.props!.nodes.find((node) => node.id === id)!;
const nodeIds = () => captured.props!.nodes.map((node) => node.id);
const copies = () =>
  captured.props!.nodes.filter((node) => !ORIGINAL_IDS.includes(node.id));
const edgeList = () =>
  captured
    .props!.edges!.map(({ id, source, target }) => ({ id, source, target }))
    .sort((a, b) => a.id.localeCompare(b.id));
const lastSaved = () => save.mock.lastCall![0];
const savedNode = (id: string) =>
  lastSaved().nodes.find((node) => node.id === id)!;
/** Every Node ID a persisted node is wired to through a field that draws a connection. */
function linkedNodeIds(node: AssetCanvasNode): string[] {
  const data = node.data as Record<string, unknown>;
  const links = [data.images, data.references]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .concat(data.promptSource, data.source);
  return links.flatMap((link) =>
    link && typeof link === "object" && "nodeId" in link
      ? [String(link.nodeId)]
      : [],
  );
}

/** Plays React Flow's side of a drag: it moves the grabbed nodes by their IDs and reports where they are. */
async function drag(ids: string[], altKey: boolean) {
  const at = new Map(ids.map((id) => [id, { ...flowNode(id).position }]));
  const dragged = (dragging: boolean) =>
    ids.map((id) => ({ ...flowNode(id), position: at.get(id)!, dragging }));
  const report = (dragging: boolean) =>
    captured.props!.onNodesChange!(
      ids.map((id) => ({
        type: "position",
        id,
        position: at.get(id)!,
        dragging,
      })),
    );
  await act(async () =>
    captured.props!.onNodeDragStart!(
      { altKey } as never,
      dragged(true)[0]!,
      dragged(true),
    ),
  );
  return {
    by: (x: number, y: number) =>
      act(async () => {
        for (const [id, position] of at)
          at.set(id, { x: position.x + x, y: position.y + y });
        report(true);
      }),
    // The final moves and the stop come from one mouseup.
    drop: () =>
      act(async () => {
        report(false);
        captured.props!.onNodeDragStop!(
          { altKey } as never,
          dragged(false)[0]!,
          dragged(false),
        );
      }),
  };
}
/** React Flow's Delete key: it removes the selected nodes and the selected edges. */
async function pressDelete() {
  const nodes = captured.props!.nodes.filter((node) => node.selected);
  const edges = captured.props!.edges!.filter((edge) => edge.selected);
  await act(async () => {
    captured.props!.onEdgesChange!(
      edges.map((edge) => ({ type: "remove", id: edge.id })),
    );
    captured.props!.onNodesChange!(
      nodes.map((node) => ({ type: "remove", id: node.id })),
    );
    captured.props!.onNodesDelete!(nodes);
  });
}
async function shortcut(key: string, shiftKey = false) {
  const target = container.querySelector<HTMLElement>(".react-flow__node")!;
  await act(async () =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: true,
        shiftKey,
        bubbles: true,
      }),
    ),
  );
}

it("drags out an unconnected copy while the original and its connections never move", async () => {
  const before = edgeList();
  const gesture = await drag(["image"], true);
  const [copy] = copies();
  expect(copy).toMatchObject({
    type: "image",
    title: "Hero shot",
    selected: true,
    data: { panelOpen: false },
  });

  for (let step = 1; step <= 3; step++) {
    await gesture.by(40, 20);
    expect(flowNode(copy!.id)).toMatchObject({
      position: { x: 400 + 40 * step, y: 20 * step },
      dragging: true,
    });
    expect(flowNode("image").position).toEqual({ x: 400, y: 0 });
    expect(edgeList()).toEqual(before);
  }
  // Saving mid-drag is safe: the board already holds the untouched original and the unconnected copy.
  await settle();
  expect(savedNode("image")).toEqual(original("image"));
  expect(linkedNodeIds(savedNode(copy!.id))).toEqual([]);

  await gesture.drop();
  expect(flowNode("image")).toMatchObject({
    position: { x: 400, y: 0 },
    selected: false,
  });
  expect(flowNode(copy!.id)).toMatchObject({
    position: { x: 520, y: 60 },
    selected: true,
    dragging: false,
    data: { panelOpen: false },
  });
  expect(edgeList()).toEqual(before);

  await settle();
  expect(isAssetCanvasDocument(lastSaved())).toBe(true);
  expect(savedNode("image")).toEqual(original("image"));
  // Content, configuration, and Library resources survive; only the node connections are gone.
  const {
    promptSource: _promptSource,
    images: _images,
    ...content
  } = original("image").data as Extract<
    AssetCanvasNode,
    { type: "image" }
  >["data"];
  expect(savedNode(copy!.id)).toEqual({
    id: copy!.id,
    type: "image",
    title: "Hero shot",
    position: { x: 520, y: 60 },
    data: { ...content, images: [{ type: "library", assetId: "lib-ref" }] },
  });
  expect(lastSaved().edges).toEqual([
    { id: "story-edge", source: "prompt", target: "art" },
  ]);
});

it("copies a connected selection without connecting the copies to each other or to the rest of the board", async () => {
  const before = edgeList();
  const gesture = await drag(ORIGINAL_IDS, true);
  const copyOf = new Map(
    ORIGINAL_IDS.map((id, index) => [id, copies()[index]!.id]),
  );
  await gesture.by(1000, 500);
  expect(edgeList()).toEqual(before);
  await gesture.drop();

  expect(edgeList()).toEqual(before);
  await settle();
  expect(isAssetCanvasDocument(lastSaved())).toBe(true);
  expect(lastSaved().nodes).toHaveLength(10);
  expect(lastSaved().edges).toEqual([
    { id: "story-edge", source: "prompt", target: "art" },
  ]);
  for (const id of ORIGINAL_IDS) {
    expect(savedNode(id)).toEqual(original(id));
    const copy = savedNode(copyOf.get(id)!);
    expect(copy).toMatchObject({
      type: original(id).type,
      position: {
        x: original(id).position.x + 1000,
        y: original(id).position.y + 500,
      },
    });
    expect(linkedNodeIds(copy)).toEqual([]);
  }
  expect(savedNode(copyOf.get("video")!).data).toMatchObject({
    prompt: "@Image1 runs past @Image2",
    references: [{ type: "library", assetId: "lib-frame" }],
    // Aliases stay reserved, as when a reference is disconnected, so @Image1 can never silently point at a different image.
    referenceMentions: {
      Image1: { type: "node", nodeId: "image" },
      Image2: { type: "library", assetId: "lib-frame" },
    },
  });
  expect(savedNode(copyOf.get("notes")!).data).toEqual({
    text: "",
    instruction: "Summarize",
    references: [],
  });
  expect(savedNode(copyOf.get("art")!).data).toEqual({
    assetId: "art-asset",
    mediaType: "image",
  });
});

it("undoes and redoes an Option-drag as one step, and reloads the saved copy unconnected", async () => {
  const before = edgeList();
  const gesture = await drag(["image"], true);
  const copyId = copies()[0]!.id;
  await gesture.by(0, 600);
  await gesture.drop();
  await settle();
  const duplicated = lastSaved();

  await shortcut("z");
  expect(nodeIds()).toEqual(ORIGINAL_IDS);
  expect(edgeList()).toEqual(before);
  await settle();
  expect(lastSaved().nodes.map((node) => node.id)).toEqual(ORIGINAL_IDS);
  // Nothing earlier to undo: the drag recorded exactly one step.
  await shortcut("z");
  expect(nodeIds()).toEqual(ORIGINAL_IDS);

  await shortcut("z", true);
  expect(flowNode(copyId).position).toEqual({ x: 400, y: 600 });
  expect(flowNode("image").position).toEqual({ x: 400, y: 0 });
  await settle();
  expect(lastSaved()).toEqual(duplicated);

  await unmount();
  await mount(duplicated);
  expect(nodeIds()).toEqual([...ORIGINAL_IDS, copyId]);
  expect(edgeList()).toEqual(before);
});

it("leaves no copy and no history step when released where it started", async () => {
  const before = edgeList();
  const gesture = await drag(["image", "video"], true);
  expect(copies()).toHaveLength(2);
  await gesture.by(60, 0);
  await gesture.by(-60, 0);
  await gesture.drop();
  expect(nodeIds()).toEqual(ORIGINAL_IDS);
  expect(
    captured
      .props!.nodes.filter((node) => node.selected)
      .map((node) => node.id),
  ).toEqual(["image", "video"]);
  expect(edgeList()).toEqual(before);
  await settle();
  expect(save).not.toHaveBeenCalled();
  await shortcut("z");
  expect(nodeIds()).toEqual(ORIGINAL_IDS);
});

it("moves the node itself on a plain drag", async () => {
  const before = edgeList();
  const gesture = await drag(["image"], false);
  await gesture.by(100, 0);
  expect(copies()).toEqual([]);
  await gesture.drop();
  expect(flowNode("image").position).toEqual({ x: 500, y: 0 });
  expect(edgeList()).toEqual(before);
  await settle();
  expect(savedNode("image").position).toEqual({ x: 500, y: 0 });
  await shortcut("z");
  expect(flowNode("image").position).toEqual({ x: 400, y: 0 });
});

it.each([0, 1])(
  "leaves the originals in place when an Option-drag exceeds the node limit with %i free slots",
  async (freeSlots) => {
    const board = connectedBoard();
    board.nodes.push(
      ...Array.from(
        { length: MAX_ASSET_CANVAS_NODES - board.nodes.length - freeSlots },
        (_, index): AssetCanvasNode => ({
          id: `extra-${index}`,
          type: "text",
          position: { x: 0, y: 1000 },
          data: { text: "", instruction: "" },
        }),
      ),
    );
    await unmount();
    await mount(board);
    const before = nodeIds();
    await act(async () =>
      captured.props!.onNodesChange!(
        ["image", "video"].map((id) => ({
          type: "select",
          id,
          selected: true,
        })),
      ),
    );

    const gesture = await drag(["image", "video"], true);
    await gesture.by(100, 100);
    await gesture.drop();
    await settle();
    expect(nodeIds()).toEqual(before);
    expect(flowNode("image").position).toEqual(original("image").position);
    expect(flowNode("video").position).toEqual(original("video").position);
    expect(container.textContent).toContain(
      "A canvas can contain at most 2,000 nodes.",
    );
    expect(save).not.toHaveBeenCalled();
    await shortcut("z");
    expect(nodeIds()).toEqual(before);

    const move = await drag(["image"], false);
    await move.by(100, 0);
    await move.drop();
    expect(flowNode("image").position).toEqual({ x: 500, y: 0 });
  },
);

describe("undo and redo pressed mid-drag", () => {
  // An earlier edit with its own history step.
  beforeEach(async () => {
    await act(async () =>
      captured.props!.onNodesChange!([
        { type: "position", id: "art", position: { x: 0, y: 500 } },
      ]),
    );
    await settle();
  });

  it("are ignored until the drop records the drag's own step", async () => {
    const gesture = await drag(["image"], true);
    const copyId = copies()[0]!.id;
    await gesture.by(100, 0);
    for (const redo of [false, true]) {
      await shortcut("z", redo);
      expect(flowNode("art").position).toEqual({ x: 0, y: 500 });
      expect(flowNode(copyId).position).toEqual({ x: 500, y: 0 });
    }
    await gesture.drop();
    await settle();

    await shortcut("z");
    expect(nodeIds()).toEqual(ORIGINAL_IDS);
    expect(flowNode("art").position).toEqual({ x: 0, y: 500 });
    await shortcut("z");
    expect(flowNode("art").position).toEqual({ x: 0, y: 300 });
    await shortcut("z", true);
    expect(flowNode("art").position).toEqual({ x: 0, y: 500 });
    await shortcut("z", true);
    expect(flowNode(copyId).position).toEqual({ x: 500, y: 0 });
  });

  it("work again once the dragged node is deleted, which ends the drag without a stop event", async () => {
    await act(async () =>
      captured.props!.onNodesChange!([
        { type: "select", id: "image", selected: true },
      ]),
    );
    const gesture = await drag(["image"], false);
    await gesture.by(100, 0);
    await pressDelete();
    await settle();
    expect(nodeIds()).toEqual(["prompt", "art", "video", "notes"]);
    await shortcut("z");
    expect(nodeIds()).toEqual(ORIGINAL_IDS);
    expect(flowNode("image").position).toEqual({ x: 400, y: 0 });
    expect(flowNode("art").position).toEqual({ x: 0, y: 500 });
  });
});

describe("a marquee selection", () => {
  const panels = () =>
    captured
      .props!.nodes.filter((node) => node.data.panelOpen)
      .map((node) => node.id);
  beforeEach(async () => {
    await act(async () => captured.props!.onSelectionStart!({} as never));
    await act(async () =>
      captured.props!.onNodesChange!(
        ORIGINAL_IDS.map((id) => ({
          type: "select",
          id,
          selected: id === "image" || id === "video",
        })),
      ),
    );
    // A marquee also selects every edge connected to the nodes it selects.
    await act(async () =>
      captured.props!.onEdgesChange!(
        edgeList().flatMap((edge) =>
          [edge.source, edge.target].some(
            (id) => id === "image" || id === "video",
          )
            ? [{ type: "select", id: edge.id, selected: true }]
            : [],
        ),
      ),
    );
    await act(async () => captured.props!.onSelectionEnd!({} as never));
    expect(panels()).toEqual([]);
  });

  it("keeps the copies' panels closed until a copy is clicked", async () => {
    const gesture = await drag(["video", "image"], true);
    await gesture.by(0, 500);
    expect(captured.props!.nodes.filter((node) => node.selected)).toEqual(
      copies(),
    );
    expect(panels()).toEqual([]);
    await gesture.drop();
    expect(panels()).toEqual([]);
    await act(async () =>
      captured.props!.onNodeClick!(
        { target: container } as never,
        copies()[0]!,
      ),
    );
    expect(panels()).toEqual([copies()[0]!.id]);
  });

  it("deletes only the held copies when Delete is pressed mid-drag", async () => {
    const before = edgeList();
    // A stored edge Cmd-clicked into the selection along with the marquee.
    await act(async () =>
      captured.props!.onEdgesChange!([
        { type: "select", id: "story-edge", selected: true },
      ]),
    );
    const gesture = await drag(["video", "image"], true);
    await gesture.by(0, 500);
    expect(captured.props!.edges!.filter((edge) => edge.selected)).toEqual([]);
    await pressDelete();
    await gesture.by(0, 100);
    await gesture.drop();
    expect(nodeIds()).toEqual(ORIGINAL_IDS);
    expect(edgeList()).toEqual(before);
    expect(panels()).toEqual([]);
    await settle();
    // Deleting nodes normalizes absent text references to `[]`, so compare what each original holds.
    for (const id of ORIGINAL_IDS)
      expect(savedNode(id)).toMatchObject(original(id));
    expect(lastSaved().edges).toEqual(connectedBoard().edges);
  });

  it("keeps the originals' panels closed when the Option-drag is cancelled", async () => {
    const gesture = await drag(["video", "image"], true);
    await gesture.by(0, 500);
    await gesture.by(0, -500);
    await gesture.drop();
    expect(
      captured
        .props!.nodes.filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual(["image", "video"]);
    expect(panels()).toEqual([]);
  });
});
