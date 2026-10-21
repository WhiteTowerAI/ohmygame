// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ReactFlowProvider, type Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX_IMAGE_MODEL } from "../src/daemon/agent-runtimes/codex-image-provider.js";
import {
  createAssetCanvasDocument,
  createAssetGenerationNode,
} from "../src/shared/asset-canvas.js";
import type { ProjectState } from "../src/shared/contracts.js";
import type { EditorCanvas } from "../src/renderer/editor-canvas.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";
import { t } from "../src/renderer/i18n.js";

type CanvasProps = Parameters<typeof EditorCanvas<Node>>[0];
let canvasProps: CanvasProps;
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: CanvasProps) => {
    canvasProps = props;
    return (
      <ReactFlowProvider>
        {props.nodes.map((node) => {
          const Component = props.nodeTypes![node.type!];
          return (
            <Component
              key={node.id}
              {...node}
              type={node.type!}
              selected
              dragging={false}
              draggable
              selectable
              deletable
              zIndex={0}
              isConnectable
              positionAbsoluteX={0}
              positionAbsoluteY={0}
            />
          );
        })}
      </ReactFlowProvider>
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
  listImageModelCatalog: async () => ({
    models: [CODEX_IMAGE_MODEL],
    providers: [],
  }),
  listAudioModelCatalog: async () => ({ models: [], providers: [] }),
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
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("selects Codex without fake dimension options and hides its dimension controls", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const board = createAssetCanvasDocument();
  const node = createAssetGenerationNode("image", { x: 0, y: 0 });
  if (node.type !== "image") throw new Error("Expected image node");
  node.data.prompt = "Combine the references";
  node.data.resolution = "4K";
  node.data.aspectRatio = "16:9";
  board.nodes = [node];
  board.editorLayout.nodes = { [node.id]: node.position };
  const storage: CanvasBoardStorage = {
    key: "codex:board",
    boardId: "board",
    load: async () => board,
    save: async (value) => value,
    refresh: async () => undefined,
    reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value,
    jobs: async () => [],
    generate: vi.fn(),
    cancel: vi.fn(),
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <CanvasBoardEditor
        project={{ id: "codex", type: "asset-canvas" } as ProjectState}
        storage={storage}
        documents={{ documents: [] } as unknown as CanvasDocuments}
        tables={{
          storage: new CanvasTableStorage("codex"),
          open: vi.fn(),
          add: vi.fn(),
        }}
        assets={[]}
      />,
    ),
  );
  await act(async () =>
    canvasProps.onNodesChange!([
      { type: "select", id: node.id, selected: true },
    ]),
  );
  const picker = host.querySelector<HTMLButtonElement>(
    `button[aria-label^="${t("assetCanvas.imageModel")}:"]`,
  )!;
  await act(async () => picker.click());
  const option = [
    ...document.querySelectorAll<HTMLButtonElement>('button[role="option"]'),
  ].find((button) => button.textContent?.includes("Codex Image"))!;
  expect(option).toBeTruthy();
  await act(async () => option.click());
  expect(canvasProps.nodes[0]!.data).toMatchObject({
    model: { provider: "codex-cli", id: "codex-image" },
    resolution: "4K",
    aspectRatio: "16:9",
  });
  expect(
    host.querySelector(
      `button[aria-label^="${t("assetCanvas.imageAspect")}:"]`,
    ),
  ).toBeNull();
  expect(
    host.querySelector(
      `button[aria-label^="${t("assetCanvas.imageResolution")}:"]`,
    ),
  ).toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>('button[aria-label="Generate image"]')
      ?.disabled,
  ).toBe(false);
});
