// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import type { PlayableVideoClip } from "../src/shared/playable-video-clip.js";

const getNodeRuntime = vi.fn();
const getWorkspaceFile = vi.fn();
const getWorkspaceAsset = vi.fn();
const ensureProjectPreview = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeRuntime,
  getWorkspaceFile,
  getWorkspaceAsset,
  ensureProjectPreview,
}));
vi.doMock(
  path.resolve("src/renderer/playable-player.tsx"),
  async (original) => ({
    ...(await original<typeof import("../src/renderer/playable-player.js")>()),
    NodePlayer: ({ page }: { page?: string }) => (
      <div data-testid="preview" data-page={page} />
    ),
  }),
);
vi.doMock(path.resolve("src/renderer/playable-video-trim-dialog.tsx"), () => ({
  PlayableVideoTrimDialog: ({
    onApply,
  }: {
    onApply: (clip: PlayableVideoClip) => Promise<void>;
  }) => (
    <button onClick={() => void onApply({ start: 3, end: 6 })}>
      Apply Scene trim
    </button>
  ),
}));
const { PlayableNodeWorkbench } =
  await import("../src/renderer/playable-node-workbench.js");
const html =
  '<div class="backdrop" data-media="backdrop" data-type="video" data-asset="intro"></div>';
let root: Root;
let container: HTMLDivElement;
let definition: NodePlayerDefinition;
const writeClip = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  const { graph } = createStarterCodebaseWithScene("Trim", {
    width: 1280,
    height: 720,
  });
  graph.assets.intro = {
    type: "video",
    source: { kind: "workspace", path: "assets/intro.mp4" },
  };
  graph.nodes[0]!.assets = ["intro"];
  definition = {
    version: 1,
    graph,
    graphSignature: "test",
    hashes: { start: "0123456789abcdef" },
  };
  getNodeRuntime.mockResolvedValue({ available: true, web: true, definition });
  ensureProjectPreview.mockResolvedValue({ url: "https://preview.test/" });
  getWorkspaceFile.mockResolvedValue({ content: html, truncated: false });
  getWorkspaceAsset.mockResolvedValue(new Blob(["video"]));
  writeClip.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function mount(node = definition.graph.nodes[0]!, revision = 1) {
  await act(async () =>
    root.render(
      <PlayableNodeWorkbench
        projectId="project"
        node={node}
        graph={definition.graph}
        issues={[]}
        revision={revision}
        backdrop="set"
        onSetBackdrop={async () => true}
        onWriteVideoClip={writeClip}
        onClose={() => {}}
        onOpenNode={() => {}}
        onRename={() => {}}
        onWriteText={async () => true}
        onWriteMove={async () => true}
        onAddAsset={async () => "intro"}
      />,
    ),
  );
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  )!;
}
async function openMenu() {
  expect(button("Media").disabled).toBe(false);
  await act(async () => button("Media").click());
}

it("keeps the web preview and offers the shared trim dialog using its source Blob", async () => {
  await mount();
  expect(
    document
      .querySelector('[data-testid="preview"]')!
      .getAttribute("data-page"),
  ).toBe("https://preview.test/");
  await openMenu();
  expect(button("Trim video")).toBeDefined();
  await act(async () => button("Trim video").click());
  await act(async () => button("Apply Scene trim").click());
  expect(writeClip).toHaveBeenCalledExactlyOnceWith(
    { assetId: "intro", type: "video", clip: undefined },
    JSON.stringify(definition.graph.assets.intro),
    { start: 3, end: 6 },
  );
  expect(getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith(
    "project",
    "assets/intro.mp4",
  );
});

it("does not disable normal web previews when trim media cannot be read", async () => {
  getWorkspaceAsset.mockRejectedValueOnce(new Error("Unavailable"));
  await mount();
  await openMenu();
  expect(document.querySelector('[data-testid="preview"]')).not.toBeNull();
  expect(button("Trim video")).toBeUndefined();
  expect(button("As background").disabled).toBe(false);
});

it("ignores a stale video load after changing to an image Scene", async () => {
  let finish: ((value: Blob) => void) | undefined;
  getWorkspaceAsset.mockImplementationOnce(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  const imageNode = {
    ...definition.graph.nodes[0]!,
    id: "image",
    source: {
      html: "nodes/image/index.html",
      css: "nodes/image/style.css",
      javascript: "nodes/image/node.js",
    },
  };
  definition.graph.nodes.push(imageNode);
  getWorkspaceFile.mockResolvedValueOnce({
    content: html.replace('data-type="video"', 'data-type="image"'),
  });
  await mount(imageNode, 2);
  await act(async () => finish!(new Blob(["stale"])));
  await openMenu();
  expect(button("Trim video")).toBeUndefined();
  expect(document.querySelector('[data-testid="preview"]')).not.toBeNull();
});
