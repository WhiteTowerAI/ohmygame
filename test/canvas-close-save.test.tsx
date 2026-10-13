// @vitest-environment happy-dom
import path from "node:path";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactFlowInstance } from "@xyflow/react";
import { createAssetCanvasDocument } from "../src/shared/asset-canvas.js";
import type { AssetCanvasDocument, ProjectState } from "../src/shared/contracts.js";
import type { CanvasBoardStorage } from "../src/renderer/canvas-board-storage.js";
import type { CanvasDocuments } from "../src/renderer/canvas-document-node.js";

let viewport = { x: 12, y: 24, zoom: 1.2 };
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async original => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: { onInit: (instance: ReactFlowInstance) => void }) => {
    useEffect(() => { props.onInit({ getViewport: () => viewport } as ReactFlowInstance); }, []);
    return <div />;
  },
}));
vi.doMock(path.resolve("src/renderer/model-selector.tsx"), async original => ({
  ...(await original<typeof import("../src/renderer/model-selector.js")>()),
  useAgentModels: () => ({ models: [], status: "ready" }),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listImageModelCatalog: async () => ({ models: [], providers: [] }),
  listVideoModelCatalog: async () => ({ models: [], providers: [] }),
  listModel3DCatalog: async () => ({ models: [], providers: [] }),
  listModel3DOperations: async () => [],
}));
vi.doMock(path.resolve("src/renderer/library-assets.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/library-assets.js")>()),
  loadLibraryAssets: async () => [],
}));
const { CanvasBoardEditor } = await import("../src/renderer/asset-canvas-workspace.js");
const { CanvasTableStorage } = await import("../src/renderer/canvas-table-storage.js");
const save = vi.fn(async (value: AssetCanvasDocument) => value);
let flush!: () => Promise<void>;
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  viewport = { x: 12, y: 24, zoom: 1.2 };
  save.mockReset().mockImplementation(async value => value);
  const storage: CanvasBoardStorage = {
    key: "p:b", boardId: "b", load: async () => createAssetCanvasDocument(), save,
    refresh: async () => undefined, reconcile: (_submitted, current) => current,
    resolveConflict: async (_version, value) => value, jobs: async () => [],
    generate: vi.fn(), cancel: vi.fn(),
  };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<CanvasBoardEditor
    project={{ id: "p", type: "asset-canvas" } as ProjectState} storage={storage}
    documents={{ documents: [] } as unknown as CanvasDocuments}
    tables={{ storage: new CanvasTableStorage("p"), open: vi.fn(), add: vi.fn() }} assets={[]}
    onSaveReady={value => { if (value) flush = value; }}
  />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("flushes the displayed canvas viewport before the delayed move-end event and waits for disk", async () => {
  let finish!: (value: AssetCanvasDocument) => void;
  save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let saving!: Promise<void>, finished = false;
  await act(async () => { saving = flush().then(() => { finished = true; }); });
  const submitted = save.mock.calls[0]![0];
  expect(submitted.editorLayout.viewport).toEqual(viewport);
  expect(finished).toBe(false);
  await act(async () => { finish(submitted); await saving; });
  expect(finished).toBe(true);
  // A later flush must retain the view after React renders the save result.
  await act(async () => flush());
  expect(save).toHaveBeenCalledTimes(1);
});
