// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import type { NodeCodebaseUpdate } from "../src/shared/playable-codebase.js";
import type { PlayableNodeWorkbench } from "../src/renderer/playable-node-workbench.js";
import { playableBackdropDetails } from "../src/shared/playable-backdrop.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import { desktopSave } from "../src/renderer/desktop-save.js";

const base = createStarterCodebaseWithScene("Trim", {
  width: 1280,
  height: 720,
});
base.graph.assets.intro = {
  type: "video",
  source: { kind: "library", assetId: "video-original" },
};
base.graph.nodes[0]!.assets.push("intro");
const initial =
  '<div class="backdrop" data-media="backdrop" data-type="video" data-asset="intro"></div>';
let source = initial;
let workbench: Parameters<typeof PlayableNodeWorkbench>[0];
const update = vi.fn(async (_id: string, next: NodeCodebaseUpdate) => {
  if (next.sources?.["nodes/start/index.html"])
    source = next.sources["nodes/start/index.html"];
  return { revision: "saved" };
});
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: {
    onNodeDoubleClick: (event: unknown, node: { id: string }) => void;
  }) => (
    <button onClick={() => props.onNodeDoubleClick(null, { id: "start" })}>
      Open Scene
    </button>
  ),
}));
vi.doMock(path.resolve("src/renderer/playable-node-workbench.tsx"), () => ({
  PlayableNodeWorkbench: (props: typeof workbench) => {
    workbench = props;
    return <div />;
  },
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeCodebase: async () => ({ ...structuredClone(base), revision: "disk" }),
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => ({}),
  getPlayableValidation: async () => ({ issues: [] }),
  getStoryUpgrade: async () => ({ web: false }),
  getWorkspaceFile: async (_id: string, file: string) => ({
    path: file,
    content: source,
    truncated: false,
  }),
  updateNodeCodebase: update,
}));
const { PlayableEditorWorkspace } =
  await import("../src/renderer/playable-editor-workspace.js");
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  update.mockClear();
  source = initial;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <PlayableEditorWorkspace
        project={{ id: "p", type: "interactive-story" } as ProjectState}
        agentBusy={false}
        publishing={false}
        onPublish={async () => false}
        onOpenPublish={() => {}}
        onClosePublish={() => {}}
      />,
    ),
  );
  await act(async () =>
    container.querySelector("button")!.textContent === "Open Scene"
      ? container.querySelector("button")!.click()
      : [...container.querySelectorAll("button")]
          .find((element) => element.textContent === "Open Scene")!
          .click(),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  desktopSave.cancel();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("saves one Scene's range and supports Undo/Redo without changing its graph", async () => {
  await act(async () =>
    workbench.onWriteVideoClip!(
      playableBackdropDetails(initial)!,
      JSON.stringify(base.graph.assets.intro),
      { start: 2, end: 5 },
    ),
  );
  expect(source).toContain('data-clip-start="2" data-clip-end="5"');
  expect(update.mock.calls[0]![1]).toMatchObject({
    graph: base.graph,
    sourcePreconditions: { "nodes/start/index.html": initial },
  });
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    ),
  );
  expect(source).toBe(initial);
  await act(async () =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(source).toContain('data-clip-start="2" data-clip-end="5"');
});

it("refuses an Asset or range that changed while the trim dialog was open", async () => {
  source = initial.replace('data-asset="intro"', 'data-asset="other"');
  await expect(
    workbench.onWriteVideoClip!(
      playableBackdropDetails(initial)!,
      JSON.stringify(base.graph.assets.intro),
      { start: 2, end: 5 },
    ),
  ).rejects.toThrow("changed");
  expect(update).not.toHaveBeenCalled();
});
