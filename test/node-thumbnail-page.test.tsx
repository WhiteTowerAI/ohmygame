// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NodeRuntimeSnapshot } from "../src/shared/playable-runtime.js";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import { playableThumbnailHash } from "../src/shared/playable-editor.js";
import { workspaceVersion } from "../src/renderer/workspace-version.js";

const codebase = createStarterCodebaseWithScene("Thumbnail", { width: 1280, height: 720 });
const definition: NodePlayerDefinition = {
  version: 1, graph: codebase.graph, graphSignature: "thumbnail",
  compiled: { version: 1, nodes: { start: { id: "start", html: "<p>Ready</p>", css: "", javascript: "", inputs: [] } } },
};
let onSnapshot!: (snapshot: NodeRuntimeSnapshot) => void;
let finishImage!: (image: Blob) => void;
const upload = vi.fn(async () => {}), finish = vi.fn();
const loadRuntime = vi.fn(async () => ({ available: true as const, definition, web: true as const }));
const sharedSnapshot = vi.fn(async () => undefined as import("../src/shared/playable-player-protocol.js").PlayableThumbnailSnapshot | undefined);
const capture = vi.fn(() => new Promise<Blob>(resolve => { finishImage = resolve; }));
const startPreview = vi.fn(async (projectId: string) => {
  void projectId;
  return { url: "http://127.0.0.1:5555", title: "Thumbnail" };
});
let playerProps: { page?: string; preview?: unknown } = {};
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeRuntime: loadRuntime,
  ensureProjectPreview: startPreview,
  setPlayableThumbnail: upload,
}));
vi.doMock(path.resolve("src/renderer/page-capture.ts"), () => ({ captureElementImage: capture }));
vi.doMock(path.resolve("src/renderer/playable-player.tsx"), () => ({
  NodePlayer: (props: { onSnapshot(snapshot: NodeRuntimeSnapshot): void; page?: string; preview?: unknown }) => {
    onSnapshot = props.onSnapshot;
    playerProps = props;
    return <div className="playable-player-frame" />;
  },
}));
const { NodeThumbnailPage } = await import("../src/renderer/node-thumbnail-page.js");
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  sharedSnapshot.mockResolvedValue(undefined);
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { finishNodeThumbnail: finish, nodeThumbnailSnapshot: sharedSnapshot } });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<NodeThumbnailPage projectId="p" nodeId="start" />));
  await act(async () => onSnapshot({ status: "running", currentNodeId: "start", errors: [] } as unknown as NodeRuntimeSnapshot));
  await act(async () => vi.advanceTimersByTimeAsync(1010));
  expect(capture).toHaveBeenCalledOnce();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); delete window.ohMyGameDesktop;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("stores a successful capture after the ready frame has painted", async () => {
  const image = new Blob(["image"], { type: "image/webp" });
  await act(async () => finishImage(image));
  expect(upload).toHaveBeenCalledExactlyOnceWith("p", "start", playableThumbnailHash(definition, "start"), image, "0");
  expect(finish).toHaveBeenCalledExactlyOnceWith(true, undefined);
});

it("uses the batch snapshot and its workspace version without rebuilding", async () => {
  sharedSnapshot.mockResolvedValue({ definition, version: "before-restore", web: true });
  loadRuntime.mockClear();
  capture.mockClear();
  await act(async () => root.render(<NodeThumbnailPage key="shared" projectId="p" nodeId="start" />));
  expect(loadRuntime).not.toHaveBeenCalled();
  await act(async () => onSnapshot({ status: "running", currentNodeId: "start", errors: [] } as unknown as NodeRuntimeSnapshot));
  await act(async () => vi.advanceTimersByTimeAsync(1010));
  const image = new Blob(["shared"], { type: "image/webp" });
  await act(async () => finishImage(image));
  expect(upload).toHaveBeenCalledExactlyOnceWith("p", "start", playableThumbnailHash(definition, "start"), image, "before-restore");
});

it("does not capture a story the editor has not upgraded to a web story yet", async () => {
  sharedSnapshot.mockResolvedValue({ definition, version: "0" });
  finish.mockClear();
  startPreview.mockClear();
  await act(async () => root.render(<NodeThumbnailPage key="sandbox" projectId="p" nodeId="start" />));
  expect(startPreview).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledExactlyOnceWith(false, "The story has not been upgraded to a web story yet.");
});

it("discards an in-flight capture when the runtime fails", async () => {
  await act(async () => onSnapshot({ status: "failed", currentNodeId: "start", errors: [] } as unknown as NodeRuntimeSnapshot));
  await act(async () => finishImage(new Blob(["image"])));
  expect(upload).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledExactlyOnceWith(false, "The Scene failed to start.");
});

it("captures the story from its own page, previewing the Scene without sound", async () => {
  expect(playerProps.page).toBe("http://127.0.0.1:5555");
  expect(playerProps.preview).toEqual({ policy: "report", startNodeId: "start", silent: true });
});

it("starts a restored web story's preview with the batch's workspace version", async () => {
  let versionAtStart: string | undefined;
  startPreview.mockImplementationOnce(async (projectId) => {
    versionAtStart = workspaceVersion(projectId);
    return { url: "http://127.0.0.1:5555", title: "Thumbnail" };
  });
  sharedSnapshot.mockResolvedValue({ definition, version: "restored", web: true });
  await act(async () => root.render(<NodeThumbnailPage key="restored" projectId="restored" nodeId="start" />));
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(versionAtStart).toBe("restored");
  expect(playerProps.page).toBe("http://127.0.0.1:5555");
});

it("reports why a web story's preview could not start", async () => {
  startPreview.mockRejectedValueOnce(new Error("The workspace was restored. Reload it before saving changes."));
  sharedSnapshot.mockResolvedValue({ definition, version: "0", web: true });
  finish.mockClear();
  await act(async () => root.render(<NodeThumbnailPage key="refused" projectId="p" nodeId="start" />));
  await act(async () => vi.advanceTimersByTimeAsync(10));
  expect(finish).toHaveBeenCalledExactlyOnceWith(false, "The workspace was restored. Reload it before saving changes.");
});
