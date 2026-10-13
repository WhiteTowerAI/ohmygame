// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AsyncTaskPool } from "../src/desktop/async-task-pool.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { playableThumbnailHash, type PlayableThumbnailManifest } from "../src/shared/playable-editor.js";

const codebase = createStarterCodebaseWithScene("Review", { width: 1280, height: 720 });
const template = codebase.graph.nodes[0]!;
codebase.graph.nodes = ["start", "b", "c", "d"].map((id) => ({ ...template, id,
  source: { html: `nodes/${id}/index.html`, css: `nodes/${id}/style.css`, javascript: `nodes/${id}/node.js` } }));
codebase.editorLayout.nodes = Object.fromEntries(codebase.graph.nodes.map((node, index) => [node.id, { x: index * 300, y: 0 }]));
const definition = { version: 1 as const, graph: codebase.graph, graphSignature: "review", compiled: { version: 1 as const,
  nodes: Object.fromEntries(codebase.graph.nodes.map(node => [node.id, { id: node.id, inputs: [], html: `<p>${node.id}</p>`, css: "", javascript: "" }])) } };
let manifest: PlayableThumbnailManifest;
let currentDefinition = structuredClone(definition);
let canvasNodes: Array<{ id: string; data: { thumbnail?: { stale: boolean } } }>;

vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async original => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: { nodes: typeof canvasNodes }) => { canvasNodes = props.nodes; return <div />; },
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeCodebase: async () => ({ ...structuredClone(codebase), revision: "disk" }),
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => structuredClone(manifest),
  getPlayableValidation: async () => ({ issues: [], definition: structuredClone(currentDefinition) }),
  getWorkspaceFile: async (_id: string, file: string) => ({ path: file, content: "source", truncated: false }),
}));
const { PlayableEditorWorkspace } = await import("../src/renderer/playable-editor-workspace.js");
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => { manifest = {}; canvasNodes = []; currentDefinition = structuredClone(definition); });
afterEach(async () => { await dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });

async function openWorkspace() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pool = new AsyncTaskPool(2);
  const controllers = new Map<string, AbortController>();
  const jobs: Array<{ nodeId: string; finish(value: boolean): void }> = [];
  const capture = vi.fn((_projectId: string, id: string, _viewport: unknown, batchId: string) => {
    let controller = controllers.get(batchId);
    if (!controller) { controller = new AbortController(); controllers.set(batchId, controller); }
    let finish!: (value: boolean) => void;
    const promise = new Promise<boolean>(resolve => { finish = resolve; });
    jobs.push({ nodeId: id, finish });
    const hash = playableThumbnailHash(currentDefinition, id)!;
    return pool.run(async () => {
      const captured = await promise;
      if (captured) manifest[id] = { hash, capturedAt: "now" };
      return captured;
    }, controller.signal).catch(() => false);
  });
  const cancel = vi.fn(async (batchId: string) => { controllers.get(batchId)?.abort(); });
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: {
    captureNodeThumbnail: capture, cancelNodeThumbnails: cancel,
  } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  dispose = async () => {
    await act(async () => { root.unmount(); for (const job of jobs) job.finish(false); });
    container.remove(); delete window.ohMyGameDesktop;
  };
  const render = (revision: number) => act(async () => root.render(<PlayableEditorWorkspace
    project={{ id: "p", type: "interactive-story" } as ProjectState} agentBusy={false} publishing={false}
    workspaceRevision={revision} onPublish={async () => false} onOpenPublish={() => {}} onClosePublish={() => {}}
  />));
  await render(0);
  return { capture, cancel, render, jobs };
}

it("resubmits queued thumbnails after a workspace revision cancels the old batch", async () => {
  const { capture, cancel, render } = await openWorkspace();
  expect(capture.mock.calls.map(call => call[1])).toEqual(["start", "b", "c", "d"]);
  await render(1);
  expect(cancel).toHaveBeenCalled();
  // C never ran in the old pool; it must be resubmitted for the current build.
  expect(capture.mock.calls.filter(call => call[1] === "c")).toHaveLength(2);
});

it("publishes each completed thumbnail while another capture is still running", async () => {
  const { capture, jobs } = await openWorkspace();
  await act(async () => jobs.find(job => job.nodeId === "b")!.finish(true));
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnail).toEqual({ capturedAt: "now", stale: false });
  expect(canvasNodes.find(node => node.id === "start")?.data.thumbnail).toBeUndefined();
  expect(capture).toHaveBeenCalledTimes(4);
});

it("ignores results from a cancelled build while publishing the current build", async () => {
  const { render, jobs } = await openWorkspace();
  currentDefinition.compiled.nodes.b!.html = "<p>Changed</p>";
  await render(1);
  await act(async () => jobs[1]!.finish(true));
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnail).toBeUndefined();
  await act(async () => jobs[4]!.finish(false));
  await act(async () => jobs[5]!.finish(true));
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnail).toMatchObject({ stale: false });
});
