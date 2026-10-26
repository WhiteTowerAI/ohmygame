// @vitest-environment happy-dom
import path from "node:path";
import { act, isValidElement, type ReactElement } from "react";
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
  ToolJob,
} from "../src/shared/contracts.js";
import { mergeCanvasDocument } from "../src/shared/canvas-workspace.js";
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
const generateText = vi.fn();
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/canvas-api.js")>()),
  generateCanvasText: generateText,
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
const generate = vi.fn();
const jobs = vi.fn<CanvasBoardStorage["jobs"]>();
const refresh = vi.fn<CanvasBoardStorage["refresh"]>();
const mediaJob = (nodeId: string, status: ToolJob["status"] = "succeeded"): ToolJob => ({
  id: `job-${nodeId}`, toolId: "generate-image", createdAt: "2026-10-26T00:00:00Z",
  title: nodeId, status, context: { projectId: "p", boardId: "b", nodeId },
});
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
async function mount(board: AssetCanvasDocument) {
  captured.props = undefined;
  const storage: CanvasBoardStorage = {
    key: "p:b",
    boardId: "b",
    load: async () => structuredClone(board),
    save,
    refresh,
    reconcile: (submitted, current, saved) => mergeCanvasDocument(submitted, current, saved)!,
    resolveConflict: async (_version, value) => value,
    jobs,
    generate,
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
        documents={{ documents: [], flush: vi.fn(async () => {}) } as unknown as CanvasDocuments}
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
  generate.mockReset().mockImplementation(async (id: string) => mediaJob(id));
  generateText.mockReset();
  jobs.mockReset().mockResolvedValue([]);
  refresh.mockReset().mockResolvedValue(undefined);
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

describe("canvas grouping interactions", () => {
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
  const groupNodes = () =>
    captured.props!.nodes.filter((node) => node.type === "group");
  async function groupPair() {
    await select(["prompt", "art"]);
    await shortcut("g");
    return groupNodes()[0]!;
  }

  it("puts group and ungroup in the floating selection toolbars", async () => {
    await select(["prompt", "art"]);
    expect(captured.props!.selectionAction).toBeUndefined();
    let toolbar = (captured.props!.children as ReactElement[]).find((child) => isValidElement(child) && typeof child.type === "function" && child.type.name === "MediaCanvasToolbarOverlay")!;
    expect(toolbar).toBeDefined();
    expect((toolbar.props as { onGroup?: () => void }).onGroup).toBeTypeOf("function");
    await act(async () => (toolbar.props as { onGroup: () => void }).onGroup());
    const grouped = groupNodes()[0]!;
    toolbar = (captured.props!.children as ReactElement[]).find((child) => isValidElement(child) && typeof child.type === "function" && child.type.name === "GroupCanvasToolbarOverlay")!;
    expect(toolbar).toBeDefined();
    await act(async () => (toolbar.props as { onUngroup: () => void }).onUngroup());
    expect(groupNodes()).toHaveLength(0);
    expect(flowNode("prompt").parentId).toBeUndefined();
    expect(flowNode("art").parentId).toBeUndefined();
    expect(grouped.id).toBeDefined();

    await select(["prompt", "notes"]);
    toolbar = (captured.props!.children as ReactElement[]).find((child) => isValidElement(child) && typeof child.type === "function" && child.type.name === "SelectionCanvasToolbarOverlay")!;
    expect(toolbar).toBeDefined();
    expect((toolbar.props as { onGroup?: () => void }).onGroup).toBeTypeOf("function");
  });

  it("shows group actions for a selected frame and runs its nested generation nodes", async () => {
    const inner = await groupPair();
    await select([inner.id, "image"]);
    await shortcut("g");
    const outer = groupNodes().find((node) => node.id !== inner.id)!;
    await select([outer.id]);
    expect(captured.props!.selectionAction).toBeUndefined();
    const toolbar = (captured.props!.children as ReactElement[]).find((child) => isValidElement(child) && typeof child.type === "function" && child.type.name === "GroupCanvasToolbarOverlay")!;
    expect(toolbar).toBeDefined();
    const actions = toolbar.props as { canExecute: boolean; onExecute: () => void; onUngroup: () => void; onDetails?: () => void };
    expect(actions.canExecute).toBe(true);
    expect(actions.onUngroup).toBeTypeOf("function");
    expect(actions.onDetails).toBeUndefined();
    await act(async () => actions.onExecute());
    await settle();
    expect(generate).toHaveBeenCalledWith("image");
  });

  const groupActions = () => {
    const toolbar = (captured.props!.children as ReactElement[]).find(
      (child) =>
        isValidElement(child) &&
        typeof child.type === "function" &&
        child.type.name === "GroupCanvasToolbarOverlay",
    )!;
    return toolbar.props as { canExecute: boolean; onExecute: () => void };
  };
  async function mountGenerationGroup(nodes: AssetCanvasNode[]) {
    await unmount();
    const board = createAssetCanvasDocument();
    board.nodes = [
      {
        id: "frame",
        type: "group",
        position: { x: 0, y: 0 },
        width: 2000,
        height: 2000,
        data: { name: "Workflow" },
      },
      ...nodes.map((node) => ({ ...node, parentId: "frame" })),
    ];
    board.editorLayout.nodes = Object.fromEntries(
      board.nodes.map((node) => [
        node.id,
        {
          ...node.position,
          ...(node.width ? { width: node.width, height: node.height } : {}),
        },
      ]),
    );
    await mount(board);
    await select(["frame"]);
  }
  function imageNode(id: string): Extract<AssetCanvasNode, { type: "image" }> {
    const node = createAssetGenerationNode("image", { x: 20, y: 50 });
    if (node.type !== "image") throw new Error("Expected image");
    return { ...node, id };
  }
  function videoNode(
    source: string,
  ): Extract<AssetCanvasNode, { type: "video" }> {
    const node = createAssetGenerationNode("video", { x: 600, y: 50 });
    if (node.type !== "video") throw new Error("Expected video");
    return {
      ...node,
      id: "downstream",
      data: {
        ...node.data,
        prompt: "Animate",
        references: [{ type: "node", nodeId: source }],
      },
    };
  }

  it.each(["video", "model-3d"] as const)(
    "waits for an image and syncs its output before a dependent %s, even in reverse node order",
    async (type) => {
      const image = imageNode("upstream");
      const model = createAssetGenerationNode("model-3d", { x: 600, y: 50 });
      if (model.type !== "model-3d") throw new Error("Expected model-3d");
      const downstream =
        type === "video"
          ? videoNode(image.id)
          : {
              ...model,
              id: "downstream",
              data: {
                ...model.data,
                images: [{ type: "node" as const, nodeId: image.id }],
              },
            };
      let status: ToolJob["status"] = "running";
      generate.mockImplementation(async (id: string) => {
        if (id === image.id) return mediaJob(id, "running");
        expect(savedNode(image.id).data).toHaveProperty(
          "assetId",
          "fresh-output",
        );
        return mediaJob(id);
      });
      jobs.mockImplementation(async () =>
        generate.mock.calls.length ? [mediaJob(image.id, status)] : [],
      );
      refresh.mockImplementation(async (canvas) =>
        status === "succeeded"
          ? {
              ...canvas,
              nodes: canvas.nodes.map((node) =>
                node.id === image.id
                  ? ({
                      ...node,
                      data: { ...node.data, assetId: "fresh-output" },
                    } as AssetCanvasNode)
                  : node,
              ),
            }
          : undefined,
      );
      await mountGenerationGroup([downstream, image]);
      const actions = groupActions();
      await act(async () => {
        actions.onExecute();
        actions.onExecute();
      });
      await settle();
      expect(generate.mock.calls.map(([id]) => id)).toEqual([image.id]);
      expect(groupActions().canExecute).toBe(false);
      status = "succeeded";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(generate.mock.calls.map(([id]) => id)).toEqual([
        image.id,
        "downstream",
      ]);
      expect(groupActions().canExecute).toBe(true);
      expect(flowNode(image.id).data.assetId).toBe("fresh-output");
    },
  );

  it("runs up to three independent media jobs and fills a free slot without waiting for the others", async () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      imageNode(`image-${index}`),
    );
    const finished = new Set<string>();
    generate.mockImplementation(async (id: string) => mediaJob(id, "running"));
    jobs.mockImplementation(async () =>
      generate.mock.calls.map(([id]) =>
        mediaJob(id, finished.has(id) ? "succeeded" : "running"),
      ),
    );
    await mountGenerationGroup(nodes);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generate.mock.calls.map(([id]) => id)).toEqual(
      nodes.slice(0, 3).map((node) => node.id),
    );
    expect(groupActions().canExecute).toBe(false);
    finished.add(nodes[1]!.id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(generate.mock.calls.map(([id]) => id)).toEqual(
      nodes.slice(0, 4).map((node) => node.id),
    );
    finished.add(nodes[3]!.id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(generate.mock.calls.map(([id]) => id)).toEqual(
      nodes.map((node) => node.id),
    );
    expect(groupActions().canExecute).toBe(false);
    nodes.forEach((node) => finished.add(node.id));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(groupActions().canExecute).toBe(true);
  });

  it("starts ready dependents while an unrelated job is running and waits for every required output", async () => {
    const first = imageNode("first"),
      second = imageNode("second");
    const child = videoNode(first.id);
    const combined = imageNode("combined");
    combined.data.images = [first, second].map((node) => ({
      type: "node",
      nodeId: node.id,
    }));
    const finished = new Set<string>();
    generate.mockImplementation(async (id: string) => {
      if (id === child.id || id === combined.id) {
        expect(savedNode(first.id).data).toHaveProperty("assetId", "fresh-first");
        if (id === combined.id)
          expect(savedNode(second.id).data).toHaveProperty(
            "assetId",
            "fresh-second",
          );
        return mediaJob(id);
      }
      return mediaJob(id, "running");
    });
    jobs.mockImplementation(async () =>
      [first, second]
        .filter((node) => generate.mock.calls.some(([id]) => id === node.id))
        .map((node) =>
          mediaJob(node.id, finished.has(node.id) ? "succeeded" : "running"),
        ),
    );
    refresh.mockImplementation(async (canvas) => ({
      ...canvas,
      nodes: canvas.nodes.map((node) =>
        finished.has(node.id)
          ? ({
              ...node,
              data: { ...node.data, assetId: `fresh-${node.id}` },
            } as AssetCanvasNode)
          : node,
      ),
    }));
    await mountGenerationGroup([combined, child, first, second]);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generate.mock.calls.map(([id]) => id)).toEqual([first.id, second.id]);
    finished.add(first.id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(generate.mock.calls.map(([id]) => id)).toEqual([
      first.id,
      second.id,
      child.id,
    ]);
    expect(groupActions().canExecute).toBe(false);
    finished.add(second.id);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(generate.mock.calls.map(([id]) => id)).toEqual([
      first.id,
      second.id,
      child.id,
      combined.id,
    ]);
    expect(groupActions().canExecute).toBe(true);
  });

  it("generates independent text nodes together, keeps their busy state separate, and preserves both outputs", async () => {
    const model = { provider: "custom", id: "node-model" };
    const first: AssetCanvasNode = {
      id: "first",
      type: "text",
      position: { x: 20, y: 50 },
      data: { instruction: "First", text: "old-first", model },
    };
    const second: AssetCanvasNode = {
      id: "second",
      type: "text",
      position: { x: 400, y: 50 },
      data: { instruction: "Second", text: "old-second", model },
    };
    const image = imageNode("image");
    image.data.promptSource = { type: "node", nodeId: second.id };
    const finish = new Map<
      string,
      (value: { text: string; model: typeof model }) => void
    >();
    generateText.mockImplementation(
      (_project, _instruction, _model, _reasoning, source) =>
        new Promise((resolve) => {
          finish.set(source.nodeId, resolve);
        }),
    );
    generate.mockImplementation(async (id: string) => {
      expect(savedNode(second.id).data).toHaveProperty("text", "new-second");
      return mediaJob(id);
    });
    await mountGenerationGroup([image, first, second]);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generateText).toHaveBeenCalledTimes(2);
    for (const node of [first, second]) {
      expect(flowNode(node.id).data.textRuntime).toMatchObject({
        generating: true,
        busy: true,
      });
    }
    const runtime = flowNode(first.id).data.textRuntime as {
      onGenerate: (chosenModel: typeof model, reasoning: "medium") => void;
    };
    await act(async () => runtime.onGenerate(model, "medium"));
    expect(generateText).toHaveBeenCalledTimes(2);
    await act(async () => finish.get(second.id)!({ text: "new-second", model }));
    await settle();
    expect(generate).toHaveBeenCalledWith(image.id);
    expect(flowNode(first.id).data.textRuntime).toMatchObject({
      generating: true,
      busy: true,
    });
    expect(flowNode(second.id).data.textRuntime).toMatchObject({
      generating: false,
      busy: false,
    });
    expect(groupActions().canExecute).toBe(false);
    await act(async () => finish.get(first.id)!({ text: "new-first", model }));
    await settle();
    expect(savedNode(first.id).data).toHaveProperty("text", "new-first");
    expect(savedNode(second.id).data).toHaveProperty("text", "new-second");
    expect(groupActions().canExecute).toBe(true);
  });

  it("uses each text node's own model without a default and saves new text before dependent requests", async () => {
    const model = { provider: "custom", id: "node-model" };
    const first: AssetCanvasNode = {
      id: "first",
      type: "text",
      position: { x: 20, y: 50 },
      data: { instruction: "Write first", text: "old", model },
    };
    const second: AssetCanvasNode = {
      id: "second",
      type: "text",
      position: { x: 400, y: 50 },
      data: {
        instruction: "Write second",
        text: "old",
        model,
        references: [{ type: "node", nodeId: first.id }],
      },
    };
    const image = imageNode("image");
    image.data.promptSource = { type: "node", nodeId: second.id };
    generateText.mockImplementation(
      async (_project, instruction, chosenModel, _reasoning, source) => {
        expect(chosenModel).toEqual(model);
        if (source.nodeId === second.id)
          expect(savedNode(first.id).data).toHaveProperty(
            "text",
            "New Write first",
          );
        return { text: `New ${instruction}`, model: chosenModel };
      },
    );
    generate.mockImplementation(async (id: string) => {
      expect(savedNode(second.id).data).toHaveProperty(
        "text",
        "New Write second",
      );
      return mediaJob(id);
    });
    await mountGenerationGroup([image, second, first]);
    expect(groupActions().canExecute).toBe(true);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generateText.mock.calls.map((call) => call[4].nodeId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(generate).toHaveBeenCalledWith(image.id);
    expect(groupActions().canExecute).toBe(true);
    expect(container.textContent).not.toContain("Skipped");
  });

  it("enables a group containing only a text node with its own model", async () => {
    const model = { provider: "custom", id: "node-model" };
    const text: AssetCanvasNode = {
      id: "text",
      type: "text",
      position: { x: 20, y: 50 },
      data: { instruction: "Write", text: "", model },
    };
    generateText.mockResolvedValue({ text: "New text", model });
    await mountGenerationGroup([text]);
    expect(groupActions().canExecute).toBe(true);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(savedNode(text.id).data).toHaveProperty("text", "New text");
  });

  it.each(["failed", "cancelled"] as const)(
    "skips dependent jobs when a running upstream later becomes %s",
    async (terminal) => {
      const image = imageNode("upstream");
      let status: ToolJob["status"] = "running";
      generate.mockImplementation(async (id: string) => mediaJob(id, "running"));
      jobs.mockImplementation(async () =>
        generate.mock.calls.length ? [mediaJob(image.id, status)] : [],
      );
      await mountGenerationGroup([videoNode(image.id), image]);
      await act(async () => groupActions().onExecute());
      await settle();
      expect(groupActions().canExecute).toBe(false);
      status = terminal;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(generate.mock.calls.map(([id]) => id)).toEqual([image.id]);
      expect(container.textContent).toContain("Skipped because a dependency");
      expect(groupActions().canExecute).toBe(true);
    },
  );

  it("skips dependents when synchronizing a completed output fails", async () => {
    const image = imageNode("upstream");
    await mountGenerationGroup([videoNode(image.id), image]);
    refresh.mockRejectedValue(new Error("Board changed elsewhere"));
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generate.mock.calls.map(([id]) => id)).toEqual([image.id]);
    expect(container.textContent).toContain("Board changed elsewhere");
    expect(container.textContent).toContain("Skipped because a dependency");
  });

  it("recognizes a completion polled before the start request returns", async () => {
    const image = imageNode("upstream");
    let finishStart: (job: ToolJob) => void = () => {};
    generate.mockImplementation((id: string) =>
      id === image.id
        ? new Promise<ToolJob>((resolve) => {
            finishStart = resolve;
          })
        : Promise.resolve(mediaJob(id)),
    );
    jobs.mockImplementation(async () =>
      generate.mock.calls.length ? [mediaJob(image.id)] : [],
    );
    await mountGenerationGroup([videoNode(image.id), image]);
    await act(async () => groupActions().onExecute());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    await act(async () => finishStart(mediaJob(image.id, "running")));
    await settle();
    expect(generate.mock.calls.map(([id]) => id)).toEqual([
      image.id,
      "downstream",
    ]);
    expect(groupActions().canExecute).toBe(true);
  });

  it.each(["failed", "cancelled", "request-rejected"] as const)(
    "skips transitive dependents after %s while continuing independent nodes",
    async (status) => {
      const image = imageNode("upstream");
      const model = createAssetGenerationNode("model-3d", { x: 600, y: 50 });
      if (model.type !== "model-3d") throw new Error("Expected model-3d");
      model.data.images = [{ type: "node", nodeId: image.id }];
      const animation: AssetCanvasNode = {
        id: "animation",
        type: "animate-3d",
        position: { x: 1000, y: 50 },
        data: {
          source: { type: "node", nodeId: model.id },
          actionIds: [],
          heightMeters: 1.8,
        },
      };
      const independent = imageNode("independent");
      generate.mockImplementation(async (id: string) => {
        if (id !== image.id) return mediaJob(id);
        if (status === "request-rejected")
          throw new Error("Provider unavailable");
        return { ...mediaJob(id, status), error: "Provider stopped" };
      });
      await mountGenerationGroup([
        videoNode(image.id),
        animation,
        model,
        image,
        independent,
      ]);
      await act(async () => groupActions().onExecute());
      await settle();
      expect(generate.mock.calls.map(([id]) => id)).toEqual([
        image.id,
        independent.id,
      ]);
      expect(container.textContent).toContain(
        status === "request-rejected"
          ? "Provider unavailable"
          : "Provider stopped",
      );
      expect(
        container.textContent.match(/Skipped because a dependency/g),
      ).toHaveLength(3);
      expect(groupActions().canExecute).toBe(true);
    },
  );

  it("does not run dependents with stale text after text generation fails", async () => {
    const text: AssetCanvasNode = {
      id: "text",
      type: "text",
      position: { x: 20, y: 50 },
      data: {
        instruction: "Write",
        text: "stale",
        model: { provider: "custom", id: "model" },
      },
    };
    const image = imageNode("image");
    image.data.promptSource = { type: "node", nodeId: text.id };
    generateText.mockRejectedValue(new Error("Text generation failed"));
    await mountGenerationGroup([image, text]);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Text generation failed");
    expect(container.textContent).toContain("Skipped because a dependency");
  });

  it("rejects circular generation references before starting any jobs", async () => {
    const first = imageNode("first"),
      second = imageNode("second");
    first.data.images = [{ type: "node", nodeId: second.id }];
    second.data.images = [{ type: "node", nodeId: first.id }];
    await mountGenerationGroup([first, second]);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("circular generation references");
    expect(groupActions().canExecute).toBe(true);
  });

  it("waits for a job that was already running instead of starting it again", async () => {
    const image = imageNode("upstream");
    let status: ToolJob["status"] = "running";
    jobs.mockImplementation(async () => [mediaJob(image.id, status)]);
    await mountGenerationGroup([videoNode(image.id), image]);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generate).not.toHaveBeenCalled();
    status = "succeeded";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(generate.mock.calls.map(([id]) => id)).toEqual(["downstream"]);
  });

  it("stops scheduling the old group's jobs after leaving the board", async () => {
    const image = imageNode("upstream");
    generate.mockImplementation(async (id: string) => mediaJob(id, "running"));
    await mountGenerationGroup([videoNode(image.id), image]);
    await act(async () => groupActions().onExecute());
    await settle();
    expect(generate).toHaveBeenCalledTimes(1);
    await unmount();
    jobs.mockResolvedValue([mediaJob(image.id)]);
    await mount(connectedBoard());
    await settle();
    expect(generate.mock.calls.map(([id]) => id)).toEqual([image.id]);
  });

  it("frames selected nodes, persists the group, and undoes/redoes creation and naming", async () => {
    const group = await groupPair();
    expect(group).toMatchObject({
      type: "group",
      selected: true,
      dragHandle: ".canvas-group-heading",
      data: { name: "Group" },
    });
    expect(flowNode("prompt").parentId).toBe(group.id);
    expect(flowNode("art").parentId).toBe(group.id);
    await settle();
    expect(isAssetCanvasDocument(lastSaved())).toBe(true);
    await shortcut("z");
    expect(groupNodes()).toHaveLength(0);
    expect(flowNode("prompt").position).toEqual({ x: 0, y: 0 });
    await shortcut("z", true);
    expect(groupNodes()).toHaveLength(1);
    await act(async () =>
      captured.props!.onNodeDoubleClick!(
        { target: document.body } as never,
        flowNode(group.id),
      ),
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[maxlength="120"]',
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Characters");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    await settle();
    expect(flowNode(group.id).data.name).toBe("Characters");
    await shortcut("z");
    expect(flowNode(group.id).data.name).toBe("Group");
  });

  it("clamps a group at its children and still expands when the same resize reverses", async () => {
    const group = await groupPair();
    const resize = flowNode(group.id).data.resizeRuntime as { start: () => void; end: () => void };
    const initial = flowNode(group.id);
    const child = flowNode("prompt");
    const absoluteChildX = initial.position.x + child.position.x;
    const absoluteChildY = initial.position.y + child.position.y;
    await act(async () => resize.start());
    const dimension = (width: number, height = group.height!) => ({
      type: "dimensions" as const, id: group.id, resizing: true,
      setAttributes: true as const, dimensions: { width, height },
    });
    await act(async () => captured.props!.onNodesChange!([dimension(650)]));
    expect(flowNode(group.id).width).toBe(650);
    await act(async () => captured.props!.onNodesChange!([dimension(467)]));
    expect(flowNode(group.id).width).toBe(468);
    await act(async () => captured.props!.onNodesChange!([dimension(600)]));
    expect(flowNode(group.id).width).toBe(600);

    const startX = initial.position.x;
    const startY = initial.position.y;
    const right = startX + 600;
    await act(async () => captured.props!.onNodesChange!([
      { type: "position", id: group.id, position: { x: startX + 30, y: startY + 60 } },
      dimension(right - startX - 30, group.height! - 60),
      { type: "position", id: child.id, position: { x: child.position.x - 30, y: child.position.y - 60 } },
    ]));
    expect(flowNode(group.id).position.x).toBe(absoluteChildX);
    expect(flowNode(group.id).position.y).toBe(absoluteChildY);
    expect(flowNode(group.id).position.x + flowNode("prompt").position.x).toBe(absoluteChildX);
    expect(flowNode(group.id).position.y + flowNode("prompt").position.y).toBe(absoluteChildY);

    await act(async () => captured.props!.onNodesChange!([
      { type: "position", id: group.id, position: { x: startX - 100, y: startY - 80 } },
      dimension(right - startX + 100, group.height! + 80),
      { type: "position", id: child.id, position: { x: child.position.x + 130, y: child.position.y + 140 } },
    ]));
    expect(flowNode(group.id).position).toEqual({ x: startX - 100, y: startY - 80 });
    expect(flowNode(group.id).width).toBe(700);
    expect(flowNode(group.id).position.x + flowNode("prompt").position.x).toBe(absoluteChildX);
    expect(flowNode(group.id).position.y + flowNode("prompt").position.y).toBe(absoluteChildY);

    await act(async () => captured.props!.onNodesChange!([
      { type: "dimensions", id: group.id, resizing: false, dimensions: { width: 467, height: 200 } },
    ]));
    await act(async () => resize.end());
    expect(flowNode(group.id).width).toBe(700);
    await settle();
    await shortcut("z");
    expect(flowNode(group.id).position).toEqual(initial.position);
    expect(flowNode(group.id).width).toBe(initial.width);
  });

  it("moves a group as one tree and reparents children on drop without jumping", async () => {
    const group = await groupPair();
    const start = { ...group.position };
    const childStart = { ...flowNode("prompt").position };
    const gesture = await drag([group.id], false);
    await gesture.by(100, 100);
    await gesture.drop();
    expect(flowNode(group.id).position).toEqual({
      x: start.x + 100,
      y: start.y + 100,
    });
    expect(flowNode("prompt").position).toEqual(childStart);
    await settle();
    const child = await drag(["prompt"], false);
    await child.by(2000, 0);
    await child.drop();
    expect(flowNode("prompt").parentId).toBeUndefined();
    expect(flowNode("prompt").position).toEqual({ x: 2100, y: 100 });
    await settle();
    await shortcut("z");
    expect(flowNode("prompt").parentId).toBe(group.id);
    const reenter = await drag(["notes"], false);
    await reenter.by(-250, -200);
    await reenter.drop();
    expect(flowNode("notes").parentId).toBe(group.id);
    await settle();
    expect(isAssetCanvasDocument(lastSaved())).toBe(true);
  });

  it("duplicates a nested tree, selects its root, and deletes or restores all descendants together", async () => {
    const inner = await groupPair();
    await select([inner.id, "image"]);
    await shortcut("g");
    const outer = groupNodes().find((node) => node.id !== inner.id)!;
    expect(flowNode(inner.id).parentId).toBe(outer.id);
    await settle();
    await shortcut("d");
    const copiedOuter = groupNodes().find(
      (node) => node.id !== outer.id && !node.parentId,
    )!;
    const copiedInner = groupNodes().find(
      (node) => node.parentId === copiedOuter.id,
    )!;
    expect(copiedInner).toBeDefined();
    expect(
      captured.props!.nodes.filter((node) => node.parentId === copiedInner.id),
    ).toHaveLength(2);
    expect(
      captured
        .props!.nodes.filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual([copiedOuter.id]);
    await settle();
    expect(isAssetCanvasDocument(lastSaved())).toBe(true);
    const count = nodeIds().length;
    await pressDelete();
    expect(nodeIds()).toHaveLength(count - 5);
    await settle();
    await shortcut("z");
    expect(nodeIds()).toHaveLength(count);
    expect(flowNode(copiedInner.id).parentId).toBe(copiedOuter.id);
  });

  it("ungroups multiple nested frames into the nearest surviving parent", async () => {
    const inner = await groupPair();
    await select([inner.id, "image"]);
    await shortcut("g");
    const outer = groupNodes().find((node) => node.id !== inner.id)!;
    await settle();
    await select([inner.id, outer.id]);
    await shortcut("g", true);
    expect(groupNodes()).toHaveLength(0);
    expect(flowNode("prompt")).toMatchObject({
      parentId: undefined,
      position: { x: 0, y: 0 },
    });
    expect(flowNode("art")).toMatchObject({
      parentId: undefined,
      position: { x: 0, y: 300 },
    });
    await settle();
    expect(isAssetCanvasDocument(lastSaved())).toBe(true);
  });

  it("Option-drags the complete group tree and can undo the copy in one step", async () => {
    const group = await groupPair();
    await settle();
    const gesture = await drag([group.id], true);
    const copy = groupNodes().find((node) => node.id !== group.id)!;
    expect(
      captured.props!.nodes.filter((node) => node.parentId === copy.id),
    ).toHaveLength(2);
    await gesture.by(1000, 600);
    await gesture.drop();
    expect(flowNode(copy.id).position).toEqual({
      x: group.position.x + 1000,
      y: group.position.y + 600,
    });
    await settle();
    expect(isAssetCanvasDocument(lastSaved())).toBe(true);
    await shortcut("z");
    expect(groupNodes().map((node) => node.id)).toEqual([group.id]);
    expect(nodeIds()).toHaveLength(6);
  });
});
