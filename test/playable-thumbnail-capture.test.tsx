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
const definition = { version: 1 as const, graph: codebase.graph, graphSignature: "review",
  hashes: Object.fromEntries(codebase.graph.nodes.map(node => [node.id, `${node.id.padEnd(8, "0")}`.replace(/[^0-9a-f]/g, "a")])) };
let manifest: PlayableThumbnailManifest;
let currentDefinition = structuredClone(definition);
let preparation: Promise<void> | undefined;
let canvasNodes: Array<{ id: string; data: { thumbnail?: { stale: boolean }; thumbnailError?: string; coverAsset?: { type: string } } }>;

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
  getStoryUpgrade: async () => ({ web: true }),
  getWorkspaceFile: async (_id: string, file: string) => ({ path: file, content: "source", truncated: false }),
}));
const { PlayableEditorWorkspace } = await import("../src/renderer/playable-editor-workspace.js");
let dispose: (() => Promise<void>) | undefined;
beforeEach(() => { manifest = {}; canvasNodes = []; currentDefinition = structuredClone(definition); preparation = undefined; });
afterEach(async () => { await dispose?.(); dispose = undefined; vi.unstubAllGlobals(); });

async function openWorkspace() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pool = new AsyncTaskPool(2);
  const controllers = new Map<string, AbortController>();
  const jobs: Array<{ nodeId: string; finish(value: boolean | string): void }> = [];
  const capture = vi.fn((_projectId: string, id: string, _viewport: unknown, batchId: string) => {
    let controller = controllers.get(batchId);
    if (!controller) { controller = new AbortController(); controllers.set(batchId, controller); }
    // `true` stores the capture; `false` or a reason fails it.
    let finish!: (value: boolean | string) => void;
    const promise = new Promise<boolean | string>(resolve => { finish = resolve; });
    jobs.push({ nodeId: id, finish });
    const hash = playableThumbnailHash(currentDefinition, id)!;
    return pool.run(async () => {
      const value = await promise;
      if (value !== true) return { captured: false as const, error: value || "Failed" };
      manifest[id] = { hash, capturedAt: "now" };
      return { captured: true as const };
    }, controller.signal).catch(() => ({ captured: false as const, error: "Cancelled" }));
  });
  const cancel = vi.fn(async (batchId: string) => { controllers.get(batchId)?.abort(); });
  const prepare = vi.fn(async (_projectId: string, _batchId: string, _snapshot: unknown) => { await preparation; });
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: {
    captureNodeThumbnail: capture, cancelNodeThumbnails: cancel, prepareNodeThumbnails: prepare,
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
  return { capture, cancel, prepare, render, jobs };
}

it("shares one build snapshot for every capture in a batch", async () => {
  const { prepare, capture } = await openWorkspace();
  expect(prepare).toHaveBeenCalledExactlyOnceWith("p", expect.any(String), {
    definition: currentDefinition, version: "0", web: true,
  });
  const batchId = prepare.mock.calls[0]![1];
  expect(capture).toHaveBeenCalledTimes(4);
  expect(capture.mock.calls.every((call) => call[3] === batchId)).toBe(true);
});

it("does not start captures from a snapshot prepared after its build was cancelled", async () => {
  let release!: () => void;
  preparation = new Promise<void>((resolve) => { release = resolve; });
  const { capture, cancel, prepare, render } = await openWorkspace();
  expect(capture).not.toHaveBeenCalled();
  await render(1);
  expect(prepare).toHaveBeenCalledTimes(2);
  await act(async () => release());
  expect(cancel).toHaveBeenCalledWith(prepare.mock.calls[0]![1]);
  expect(capture).toHaveBeenCalledTimes(4);
  expect(capture.mock.calls.every((call) => call[3] === prepare.mock.calls[1]![1])).toBe(true);
});

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
  currentDefinition.hashes.b = "bbbbbbbbbbbbbbb1";
  await render(1);
  await act(async () => jobs[1]!.finish(true));
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnail).toBeUndefined();
  await act(async () => jobs[4]!.finish(false));
  await act(async () => jobs[5]!.finish(true));
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnail).toMatchObject({ stale: false });
});

it("does not capture a failed version again until the Scene changes", async () => {
  const { capture, render, jobs } = await openWorkspace();
  await act(async () => jobs.find(job => job.nodeId === "b")!.finish("The preview could not start."));
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnailError).toBe("The preview could not start.");
  await act(async () => { for (const job of jobs.filter(job => job.nodeId !== "b")) job.finish(true); });
  await render(1);
  expect(capture.mock.calls.filter(call => call[1] === "b")).toHaveLength(1);
  currentDefinition.hashes.b = "bbbbbbbbbbbbbbb1";
  await render(2);
  expect(capture.mock.calls.filter(call => call[1] === "b")).toHaveLength(2);
  expect(canvasNodes.find(node => node.id === "b")?.data.thumbnailError).toBeUndefined();
});

it("covers a video-only Scene with its video before it is captured", async () => {
  const { assets } = codebase.graph, node = codebase.graph.nodes[1]!, nodeAssets = node.assets;
  const clip = { type: "video" as const, source: { kind: "workspace" as const, path: "assets/clip.mp4" } };
  codebase.graph.assets = { ...assets, clip };
  node.assets = ["clip"];
  try {
    await openWorkspace();
    expect(canvasNodes.find(node => node.id === "b")?.data.coverAsset).toEqual(clip);
  } finally {
    codebase.graph.assets = assets;
    node.assets = nodeAssets;
  }
});
