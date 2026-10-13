// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NodeRuntimeSnapshot } from "../src/shared/playable-runtime.js";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import { playableThumbnailHash } from "../src/shared/playable-editor.js";

const codebase = createStarterCodebaseWithScene("Thumbnail", { width: 1280, height: 720 });
const definition: NodePlayerDefinition = {
  version: 1, graph: codebase.graph, graphSignature: "thumbnail",
  compiled: { version: 1, nodes: { start: { id: "start", html: "<p>Ready</p>", css: "", javascript: "", inputs: [] } } },
};
let onSnapshot!: (snapshot: NodeRuntimeSnapshot) => void;
let finishImage!: (image: Blob) => void;
const upload = vi.fn(async () => {}), finish = vi.fn();
const capture = vi.fn(() => new Promise<Blob>(resolve => { finishImage = resolve; }));
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeRuntime: async () => ({ available: true, definition }),
  setPlayableThumbnail: upload,
}));
vi.doMock(path.resolve("src/renderer/playable-assets.ts"), () => ({ loadPlayableAssets: async () => ({}) }));
vi.doMock(path.resolve("src/renderer/page-capture.ts"), () => ({ captureElementImage: capture }));
vi.doMock(path.resolve("src/renderer/playable-player.tsx"), () => ({
  createMemoryStorage: () => ({}),
  NodePlayer: (props: { onSnapshot(snapshot: NodeRuntimeSnapshot): void }) => {
    onSnapshot = props.onSnapshot;
    return <div className="playable-player-frame" />;
  },
}));
const { NodeThumbnailPage } = await import("../src/renderer/node-thumbnail-page.js");
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers(); vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { finishNodeThumbnail: finish } });
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
  expect(upload).toHaveBeenCalledExactlyOnceWith("p", "start", playableThumbnailHash(definition, "start"), image);
  expect(finish).toHaveBeenCalledExactlyOnceWith(true);
});

it("discards an in-flight capture when the runtime fails", async () => {
  await act(async () => onSnapshot({ status: "failed", currentNodeId: "start", errors: [] } as unknown as NodeRuntimeSnapshot));
  await act(async () => finishImage(new Blob(["image"])));
  expect(upload).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledExactlyOnceWith(false);
});
