import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

const getWorkspaceFile = vi.fn();
const getWorkspaceAsset = vi.fn();
const getLibraryAsset = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getWorkspaceFile,
  getWorkspaceAsset,
  getLibraryAsset,
}));
const { readPlayableVideoTrimSource } =
  await import("../src/renderer/playable-video-trim-source.js");
const html =
  '<div class="backdrop" data-media="backdrop" data-type="video" data-asset="intro" data-clip-start="2" data-clip-end="8"></div>';
const blob = new Blob(["video"]);
function fixture() {
  const { graph } = createStarterCodebaseWithScene("Trim", {
    width: 1280,
    height: 720,
  });
  graph.assets.intro = {
    type: "video",
    source: { kind: "workspace", path: "assets/intro.mp4" },
  };
  graph.nodes[0]!.assets = ["intro"];
  return graph;
}
beforeEach(() => {
  vi.resetAllMocks();
  getWorkspaceFile.mockResolvedValue({ content: html, truncated: false });
  getWorkspaceAsset.mockResolvedValue(blob);
  getLibraryAsset.mockResolvedValue(blob);
});

it("loads the authored video for a web preview without loading other assets", async () => {
  const graph = fixture();
  graph.assets.unrelated = {
    type: "video",
    source: { kind: "workspace", path: "assets/large.mp4" },
  };
  const result = await readPlayableVideoTrimSource(
    "project",
    graph.nodes[0]!,
    graph,
  );
  expect(getWorkspaceFile).toHaveBeenCalledExactlyOnceWith(
    "project",
    graph.nodes[0]!.source.html,
  );
  expect(getWorkspaceAsset).toHaveBeenCalledExactlyOnceWith(
    "project",
    "assets/intro.mp4",
  );
  expect(getLibraryAsset).not.toHaveBeenCalled();
  expect(result).toEqual({
    details: { assetId: "intro", type: "video", clip: { start: 2, end: 8 } },
    source: JSON.stringify(graph.assets.intro),
    blob,
  });
});

it("supports a Library background while the story awaits Copy into project", async () => {
  const graph = fixture();
  graph.assets.intro = {
    type: "video",
    source: { kind: "library", assetId: "library-video" },
  };
  const result = await readPlayableVideoTrimSource(
    "project",
    graph.nodes[0]!,
    graph,
  );
  expect(result?.blob).toBe(blob);
  expect(getLibraryAsset).toHaveBeenCalledExactlyOnceWith("library-video");
  expect(getWorkspaceAsset).not.toHaveBeenCalled();
});

it.each(["truncated", "missing", "image", "undeclared", "wrong-type"])(
  "does not load a Blob for an ineligible background: %s",
  async (kind) => {
    const graph = fixture();
    if (kind === "truncated")
      getWorkspaceFile.mockResolvedValue({ content: html, truncated: true });
    if (kind === "missing")
      getWorkspaceFile.mockResolvedValue({ truncated: false });
    if (kind === "image")
      getWorkspaceFile.mockResolvedValue({
        content: html.replace('data-type="video"', 'data-type="image"'),
      });
    if (kind === "undeclared") graph.nodes[0]!.assets = [];
    if (kind === "wrong-type") graph.assets.intro!.type = "image";
    expect(
      await readPlayableVideoTrimSource("project", graph.nodes[0]!, graph),
    ).toBeUndefined();
    expect(getWorkspaceAsset).not.toHaveBeenCalled();
    expect(getLibraryAsset).not.toHaveBeenCalled();
  },
);
