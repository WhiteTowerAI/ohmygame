// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";
import type {
  NodeCodebaseDetail,
  NodeCodebaseUpdate,
} from "../src/shared/playable-codebase.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

type FlowNode = Node & { title?: string };
type CanvasProps = Parameters<typeof EditorCanvas<FlowNode>>[0];
const captured = { props: undefined as CanvasProps | undefined };
const api = {
  getBoard: vi.fn<() => Promise<CanvasBoardDetail>>(),
  saveBoard:
    vi.fn<
      (
        projectId: string,
        detail: CanvasBoardDetail,
      ) => Promise<CanvasBoardDetail>
    >(),
  getCodebase: vi.fn<() => Promise<NodeCodebaseDetail>>(),
  saveCodebase:
    vi.fn<
      (
        projectId: string,
        update: NodeCodebaseUpdate,
      ) => Promise<{ revision: string }>
    >(),
};
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: CanvasProps) => {
    captured.props = props;
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
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => ({}),
  getPlayableValidation: async () => ({ issues: [] }),
  getWorkspaceFile: async (_projectId: string, file: string) => ({
    path: file,
    content: `Source of ${file}`,
    truncated: false,
  }),
  getNodeCodebase: api.getCodebase,
  updateNodeCodebase: api.saveCodebase,
}));
vi.doMock(path.resolve("src/renderer/canvas-api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/canvas-api.js")>()),
  getCanvasBoard: api.getBoard,
  saveCanvasBoard: api.saveBoard,
  listCanvasJobs: async () => [],
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [],
}));

const { createCanvasBoardStorage } =
  await import("../src/renderer/canvas-board-storage.js");
const { CanvasBoardEditor } =
  await import("../src/renderer/asset-canvas-workspace.js");
const { PlayableEditorWorkspace } =
  await import("../src/renderer/playable-editor-workspace.js");
const { ApiError } = await import("../src/renderer/api.js");

let boardDisk: CanvasBoardDetail;
let storyDisk: NodeCodebaseDetail;
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  captured.props = undefined;
  const canvas = createAssetCanvasDocument();
  canvas.nodes = [
    {
      id: "n",
      type: "text",
      title: "Original",
      position: { x: 0, y: 0 },
      data: { text: "Rules", instruction: "" },
    },
  ];
  canvas.editorLayout.nodes.n = { x: 0, y: 0 };
  boardDisk = { board: { ...canvas, id: "b" }, revision: "initial" };
  storyDisk = {
    ...createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    revision: "initial",
  };
  api.getBoard.mockImplementation(async () => structuredClone(boardDisk));
  api.saveBoard.mockImplementation(async (_projectId, detail) => {
    if (detail.revision !== boardDisk.revision)
      throw new ApiError("The board changed", 409);
    boardDisk = {
      board: structuredClone(detail.board),
      revision: `save-${api.saveBoard.mock.calls.length}`,
    };
    return structuredClone(boardDisk);
  });
  api.getCodebase.mockImplementation(async () => structuredClone(storyDisk));
  api.saveCodebase.mockImplementation(async (_projectId, update) => {
    if (update.revision !== storyDisk.revision)
      throw new ApiError("The project changed", 409);
    storyDisk = {
      graph: structuredClone(update.graph),
      editorLayout: structuredClone(update.editorLayout),
      revision: `save-${api.saveCodebase.mock.calls.length}`,
    };
    return { revision: storyDisk.revision };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = (milliseconds: number) =>
  act(async () => vi.advanceTimersByTimeAsync(milliseconds));
async function openCanvas(type: "web-game" | "asset-canvas") {
  const storage = createCanvasBoardStorage({
    projectId: "p",
    boardId: "b",
    onConflict: vi.fn(),
    flushDocuments: async () => {},
  });
  await act(async () =>
    root.render(
      <CanvasBoardEditor
        project={{ id: "p", type } as ProjectState}
        storage={storage}
        documents={{ documents: [] } as unknown as CanvasDocuments}
        assets={[]}
      />,
    ),
  );
  expect(captured.props?.nodes[0]?.title).toBe("Original");
}
async function openStory(workspaceRevision = 0) {
  await act(async () =>
    root.render(
      <PlayableEditorWorkspace
        project={{ id: "p", type: "interactive-story" } as ProjectState}
        agentBusy={false}
        publishing={false}
        workspaceRevision={workspaceRevision}
        onPublish={async () => false}
        onOpenPublish={() => {}}
        onClosePublish={() => {}}
      />,
    ),
  );
  expect(captured.props).toBeDefined();
}
async function move(id: string) {
  await act(async () =>
    captured.props!.onNodesChange!([
      { id, type: "position", position: { x: 400, y: 400 } },
    ]),
  );
}
async function undo(redo = false) {
  await act(async () =>
    container
      .querySelector(".interactive-story-canvas")!
      .dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          metaKey: true,
          shiftKey: redo,
          bubbles: true,
        }),
      ),
  );
}

it.each(["web-game", "asset-canvas"] as const)(
  "keeps an Agent rename when moving a stale %s board",
  async (type) => {
    await openCanvas(type);
    boardDisk.board.nodes[0]!.title = "Agent title";
    boardDisk.revision = "agent-edit";
    await move("n");
    await advance(400);
    expect(api.saveBoard).toHaveBeenCalledTimes(2);
    expect(boardDisk.board.nodes[0]).toMatchObject({
      title: "Agent title",
      position: { x: 400, y: 400 },
    });
    await undo();
    await advance(400);
    expect(boardDisk.board.nodes[0]!.title).toBe("Agent title");
  },
);

it.each(["web-game", "asset-canvas"] as const)(
  "does not undo an Agent edit synced to a %s board",
  async (type) => {
    await openCanvas(type);
    await move("n");
    await advance(400);
    boardDisk.board.nodes[0]!.title = "Agent title";
    boardDisk.revision = "agent-edit";
    await advance(2100);
    expect(captured.props!.nodes[0]!.title).toBe("Agent title");
    await advance(400);
    await undo();
    await advance(400);
    expect(boardDisk.board.nodes[0]!.title).toBe("Agent title");
  },
);

it("still undoes local canvas edits when no external content changed", async () => {
  await openCanvas("web-game");
  await move("n");
  await advance(500);
  await undo();
  await advance(400);
  expect(boardDisk.board.nodes[0]!.position).toEqual({ x: 0, y: 0 });
});

it("keeps the Agent graph and an independent move when a Story save conflicts", async () => {
  await openStory();
  storyDisk.graph.nodes[0]!.title = "Agent title";
  storyDisk.revision = "agent-edit";
  await move("start");
  await advance(400);
  expect(api.saveCodebase).toHaveBeenCalledTimes(2);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
  expect(storyDisk.editorLayout.nodes.start).toEqual({ x: 400, y: 400 });
  await undo();
  await advance(400);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
});

it("keeps a remote viewport when a Story save only moves a Scene", async () => {
  await openStory();
  storyDisk.editorLayout.viewport = { x: -100, y: 20, zoom: 0.5 };
  storyDisk.revision = "agent-layout";
  await move("start");
  await advance(400);
  expect(storyDisk.editorLayout.viewport).toEqual({
    x: -100,
    y: 20,
    zoom: 0.5,
  });
  expect(storyDisk.editorLayout.nodes.start).toEqual({ x: 400, y: 400 });
});

it("rejects concurrent graph edits and clears stale Story undo snapshots", async () => {
  await openStory();
  storyDisk.graph.nodes[0]!.title = "Agent title";
  storyDisk.revision = "agent-edit";
  await act(async () =>
    captured.props!.onNodesDelete!([captured.props!.nodes[0]!]),
  );
  await advance(400);
  expect(api.saveCodebase).toHaveBeenCalledTimes(1);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
  expect(container.textContent).toContain("Make your last change again");
  await undo();
  await advance(400);
  expect(storyDisk.graph.nodes).toHaveLength(1);
  expect(storyDisk.graph.nodes[0]!.title).toBe("Agent title");
});

it("preserves local undo history after a formatting-only Story conflict", async () => {
  await openStory();
  storyDisk.revision = "reformatted";
  await move("start");
  await advance(500);
  await undo();
  await advance(400);
  expect(storyDisk.editorLayout.nodes.start).toEqual({ x: 120, y: 180 });
});

it("keeps a duplicated Scene and its sources when only the disk layout changed", async () => {
  await openStory();
  storyDisk.editorLayout.viewport = { x: -100, y: 20, zoom: 0.5 };
  storyDisk.revision = "agent-layout";
  await act(async () =>
    captured.props!.onOpenMenu({
      kind: "node",
      nodeId: "start",
      screenPosition: { x: 0, y: 0 },
      flowPosition: { x: 0, y: 0 },
    }),
  );
  const duplicate = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((button) => button.textContent === "Duplicate")!;
  await act(async () => duplicate.click());
  expect(api.saveCodebase).toHaveBeenCalledTimes(2);
  const retried = api.saveCodebase.mock.calls[1]![1];
  expect(retried.graph.nodes).toHaveLength(2);
  expect(Object.keys(retried.sources!)).toHaveLength(3);
  expect(storyDisk.editorLayout.viewport).toEqual({
    x: -100,
    y: 20,
    zoom: 0.5,
  });
});
