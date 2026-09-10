import { describe, expect, it } from "vitest";
import {
  createStoryDocument,
  combineStoryPrompt,
  getNextNode,
  getOutgoingEdge,
  getStartNode,
  isStoryDocument,
  replaceOutgoingEdge,
  resolveStoryAssetId,
  resolveStoryImageAssetId,
  resolveStoryVideoClipAssetId,
  validatePlayableChapter,
} from "../src/shared/story.js";
import { VIDEO_MODEL } from "../src/shared/contracts.js";

describe("story documents", () => {
  it("combines linked text with a local media prompt", () => {
    expect(combineStoryPrompt("A woman at a train station", "Cinematic wide shot")).toBe("A woman at a train station\n\nCinematic wide shot");
    expect(combineStoryPrompt("", "Cinematic wide shot")).toBe("Cinematic wide shot");
    expect(combineStoryPrompt("A woman at a train station", "")).toBe("A woman at a train station");
  });

  it("creates one chapter with one start node", () => {
    const story = createStoryDocument();
    expect(isStoryDocument(story)).toBe(true);
    expect(isStoryDocument({ ...story, version: 2 })).toBe(false);
    expect(story.chapters).toHaveLength(1);
    expect(story.chapters[0]?.nodes).toEqual([expect.objectContaining({ type: "start" })]);
  });

  it("rejects missing starts, duplicate ids, and dangling edges", () => {
    const missingStart = createStoryDocument();
    missingStart.chapters[0]!.nodes = [];
    expect(isStoryDocument(missingStart)).toBe(false);

    const duplicate = createStoryDocument();
    duplicate.chapters[0]!.nodes.push({ ...duplicate.chapters[0]!.nodes[0]! });
    expect(isStoryDocument(duplicate)).toBe(false);

    const dangling = createStoryDocument();
    dangling.chapters[0]!.edges.push({ id: "edge", source: dangling.chapters[0]!.nodes[0]!.id, target: "missing" });
    expect(isStoryDocument(dangling)).toBe(false);

    const duplicateOutput = createStoryDocument();
    const duplicateStart = duplicateOutput.chapters[0]!.nodes[0]!;
    duplicateOutput.chapters[0]!.nodes.push(
      { id: "ending-a", type: "ending", position: { x: 0, y: 0 }, data: { title: "A", description: "" } },
      { id: "ending-b", type: "ending", position: { x: 0, y: 0 }, data: { title: "B", description: "" } },
    );
    duplicateOutput.chapters[0]!.edges.push(
      { id: "edge-a", source: duplicateStart.id, target: "ending-a" },
      { id: "edge-b", source: duplicateStart.id, sourceHandle: "out", target: "ending-b" },
    );
    expect(isStoryDocument(duplicateOutput)).toBe(false);

    const invalidHandle = createStoryDocument();
    const invalidStart = invalidHandle.chapters[0]!.nodes[0]!;
    invalidHandle.chapters[0]!.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: { title: "Choose", options: [{ id: "known", label: "Known" }] },
    });
    invalidHandle.chapters[0]!.edges.push({ id: "edge", source: "choice", sourceHandle: "missing", target: invalidStart.id });
    expect(isStoryDocument(invalidHandle)).toBe(false);

    const emptyId = createStoryDocument();
    emptyId.chapters[0]!.id = "";
    expect(isStoryDocument(emptyId)).toBe(false);

    const duplicateChapter = createStoryDocument();
    duplicateChapter.chapters.push({ ...duplicateChapter.chapters[0]! });
    expect(isStoryDocument(duplicateChapter)).toBe(false);

    const emptyEdgeId = createStoryDocument();
    emptyEdgeId.chapters[0]!.nodes.push({
      id: "ending",
      type: "ending",
      position: { x: 0, y: 0 },
      data: { title: "End", description: "" },
    });
    emptyEdgeId.chapters[0]!.edges.push({ id: "", source: emptyEdgeId.chapters[0]!.nodes[0]!.id, target: "ending" });
    expect(isStoryDocument(emptyEdgeId)).toBe(false);

    const duplicateClip = createStoryDocument();
    duplicateClip.chapters[0]!.nodes.push({
      id: "scene",
      type: "scene",
      position: { x: 0, y: 0 },
      data: {
        title: "Scene",
        clips: [
          { id: "clip", source: { type: "library", assetId: "asset-a" } },
          { id: "clip", source: { type: "library", assetId: "asset-b" } },
        ],
      },
    });
    expect(isStoryDocument(duplicateClip)).toBe(false);
  });

  it("traverses a playable scene and choice graph", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      { id: "scene", type: "scene", position: { x: 0, y: 0 }, data: { title: "Arrival", clips: [{ id: "arrival", source: { type: "library", assetId: "arrival-video" } }] } },
      {
        id: "choice",
        type: "choice",
        position: { x: 0, y: 0 },
        data: { title: "Where next?", options: [{ id: "left", label: "Go left" }, { id: "right", label: "Go right" }] },
      },
      { id: "ending-a", type: "ending", position: { x: 0, y: 0 }, data: { title: "Left", description: "" } },
      { id: "ending-b", type: "ending", position: { x: 0, y: 0 }, data: { title: "Right", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, sourceHandle: "out", target: "scene" },
      { id: "scene-choice", source: "scene", sourceHandle: "out", target: "choice" },
      { id: "left-ending", source: "choice", sourceHandle: "left", target: "ending-a" },
      { id: "right-ending", source: "choice", sourceHandle: "right", target: "ending-b" },
    );

    expect(validatePlayableChapter(chapter)).toBeUndefined();
    expect(getOutgoingEdge(chapter, "choice", "right")?.id).toBe("right-ending");
    expect(getNextNode(chapter, start.id)?.id).toBe("scene");
    expect(getNextNode(chapter, "choice", "left")?.id).toBe("ending-a");
    expect(validatePlayableChapter(chapter, new Set(["arrival-video"]))).toBeUndefined();
    expect(validatePlayableChapter(chapter, new Set())).toEqual({ nodeId: "scene", message: "A video used by this scene is missing from Library." });
  });

  it("requires a video in every reachable scene", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push({ id: "empty", type: "scene", position: { x: 0, y: 0 }, data: { title: "Empty", clips: [] } });
    chapter.edges.push({ id: "start-empty", source: start.id, target: "empty" });

    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: "empty", message: "Add at least one video to the scene \"Empty\"." });
  });

  it("reports the first missing connection on a reachable path", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: start.id, message: "Connect Start to a next node." });

    chapter.nodes.push({
      id: "choice",
      type: "choice",
      position: { x: 0, y: 0 },
      data: { title: "Choose", options: [{ id: "only", label: "Continue" }] },
    });
    chapter.edges.push({ id: "edge", source: start.id, target: "choice" });
    expect(validatePlayableChapter(chapter)).toEqual({ nodeId: "choice", message: "Connect the choice \"Continue\"." });
  });

  it("allows loops and ignores disconnected draft nodes", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      { id: "loop", type: "scene", position: { x: 0, y: 0 }, data: { title: "Loop", clips: [{ id: "loop-clip", source: { type: "library", assetId: "loop-video" } }] } },
      { id: "draft", type: "scene", position: { x: 0, y: 0 }, data: { title: "Draft", clips: [] } },
    );
    chapter.edges.push(
      { id: "enter-loop", source: start.id, target: "loop" },
      { id: "repeat-loop", source: "loop", target: "loop" },
    );

    expect(validatePlayableChapter(chapter)).toBeUndefined();
  });

  it("accepts disconnected image generation nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "image",
      type: "image",
      position: { x: 240, y: 0 },
      data: {
        prompt: "A hero portrait",
        model: { provider: "opengame", id: "gpt-image-2" },
        resolution: "1K",
        aspectRatio: "1:1",
        images: [],
      },
    });

    expect(isStoryDocument(story)).toBe(true);
  });

  it("accepts text prompts linked to image and video nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push(
      { id: "prompt", type: "text", position: { x: 0, y: 0 }, data: { text: "A forest at dawn", instruction: "Write an image prompt" } },
      {
        id: "image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "", promptSource: { type: "node", nodeId: "prompt" }, resolution: "1K", aspectRatio: "1:1", images: [] },
      },
      {
        id: "video",
        type: "video",
        position: { x: 480, y: 0 },
        data: {
          prompt: "",
          promptSource: { type: "node", nodeId: "prompt" },
          model: VIDEO_MODEL,
          resolution: "720p",
          aspectRatio: "16:9",
          duration: 6,
          references: [],
        },
      },
    );

    expect(isStoryDocument(story)).toBe(true);
  });

  it("rejects prompt references to missing or non-text nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "image",
      type: "image",
      position: { x: 240, y: 0 },
      data: { prompt: "", promptSource: { type: "node", nodeId: "missing" }, resolution: "1K", aspectRatio: "1:1", images: [] },
    });
    expect(isStoryDocument(story)).toBe(false);

    const image = story.chapters[0]!.nodes.at(-1);
    if (image?.type === "image") image.data.promptSource = { type: "node", nodeId: story.chapters[0]!.nodes[0]!.id };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("rejects invalid image generation parameters", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "image",
      type: "image",
      position: { x: 240, y: 0 },
      data: { prompt: "A hero portrait", resolution: "1K", aspectRatio: "1:1", images: [] },
    });
    const image = story.chapters[0]!.nodes.at(-1)!;

    (image.data as { resolution: string }).resolution = "8K";

    expect(isStoryDocument(story)).toBe(false);
  });

  it("accepts disconnected video generation nodes", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "video",
      type: "video",
      position: { x: 240, y: 0 },
      data: {
        prompt: "A slow camera move through a forest",
        model: VIDEO_MODEL,
        resolution: "720p",
        aspectRatio: "16:9",
        duration: 6,
        references: [],
      },
    });

    expect(isStoryDocument(story)).toBe(true);
  });

  it("accepts scene clips linked to video nodes and resolves their latest result", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      {
        id: "video",
        type: "video",
        position: { x: 240, y: 0 },
        data: {
          prompt: "A slow camera move through a forest",
          model: VIDEO_MODEL,
          resolution: "720p",
          aspectRatio: "16:9",
          duration: 6,
          references: [],
          assetId: "first-result",
        },
      },
      {
        id: "scene",
        type: "scene",
        position: { x: 600, y: 0 },
        data: { title: "Forest", clips: [{ id: "clip", source: { type: "node", nodeId: "video" } }] },
      },
    );
    const scene = chapter.nodes.find((node) => node.id === "scene");
    const clip = scene?.type === "scene" ? scene.data.clips[0]! : undefined;

    expect(isStoryDocument(story)).toBe(true);
    expect(resolveStoryVideoClipAssetId(chapter, clip!)).toBe("first-result");

    const video = chapter.nodes.find((node) => node.id === "video");
    if (video?.type === "video") video.data.assetId = "latest-result";
    expect(resolveStoryVideoClipAssetId(chapter, clip!)).toBe("latest-result");
  });

  it("rejects scene references to missing or non-video nodes", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      {
        id: "image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "A forest", resolution: "1K", aspectRatio: "1:1", images: [] },
      },
      {
        id: "scene",
        type: "scene",
        position: { x: 600, y: 0 },
        data: { title: "Forest", clips: [{ id: "clip", source: { type: "node", nodeId: "image" } }] },
      },
    );

    expect(isStoryDocument(story)).toBe(false);
    const scene = chapter.nodes.find((node) => node.id === "scene");
    if (scene?.type === "scene") scene.data.clips[0]!.source = { type: "node", nodeId: "missing" };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("requires a linked video node to have an available result before playtest", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    const start = getStartNode(chapter)!;
    chapter.nodes.push(
      {
        id: "video",
        type: "video",
        position: { x: 240, y: 0 },
        data: { prompt: "A forest", model: VIDEO_MODEL, resolution: "720p", aspectRatio: "16:9", duration: 6, references: [] },
      },
      {
        id: "scene",
        type: "scene",
        position: { x: 600, y: 0 },
        data: { title: "Forest", clips: [{ id: "clip", source: { type: "node", nodeId: "video" } }] },
      },
      { id: "ending", type: "ending", position: { x: 900, y: 0 }, data: { title: "End", description: "" } },
    );
    chapter.edges.push(
      { id: "start-scene", source: start.id, target: "scene" },
      { id: "scene-ending", source: "scene", target: "ending" },
    );

    expect(validatePlayableChapter(chapter, new Set())).toEqual({
      nodeId: "scene",
      message: "A video used by this scene is missing from Library.",
    });
    const video = chapter.nodes.find((node) => node.id === "video");
    if (video?.type === "video") video.data.assetId = "generated-video";
    expect(validatePlayableChapter(chapter, new Set(["generated-video"]))).toBeUndefined();
  });

  it("validates image inputs and resolves the latest image-node result", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      {
        id: "image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "A forest", resolution: "1K", aspectRatio: "1:1", images: [], assetId: "first-image" },
      },
      {
        id: "video",
        type: "video",
        position: { x: 600, y: 0 },
        data: {
          prompt: "Leaves moving in the wind",
          model: VIDEO_MODEL,
          resolution: "720p",
          aspectRatio: "16:9",
          duration: 6,
          references: [{ type: "node", nodeId: "image" }],
        },
      },
    );
    const video = chapter.nodes.find((node) => node.id === "video");
    const reference = video?.type === "video" ? video.data.references[0]! : undefined;

    expect(isStoryDocument(story)).toBe(true);
    expect(resolveStoryImageAssetId(chapter, reference!)).toBe("first-image");
    const image = chapter.nodes.find((node) => node.id === "image");
    if (image?.type === "image") image.data.assetId = "latest-image";
    expect(resolveStoryImageAssetId(chapter, reference!)).toBe("latest-image");

    if (video?.type === "video") video.data.references = [{ type: "node", nodeId: chapter.nodes[0]!.id }];
    expect(isStoryDocument(story)).toBe(false);
  });

  it("accepts Library and generated images as image-generation references", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "library-image", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "library-image-id", mediaType: "image" } },
      {
        id: "generated-image",
        type: "image",
        position: { x: 240, y: 0 },
        data: { prompt: "Character portrait", resolution: "1K", aspectRatio: "1:1", images: [], assetId: "generated-image-id" },
      },
      {
        id: "composite-image",
        type: "image",
        position: { x: 480, y: 0 },
        data: {
          prompt: "Place the character in this environment",
          resolution: "1K",
          aspectRatio: "16:9",
          images: [{ type: "node", nodeId: "library-image" }, { type: "node", nodeId: "generated-image" }],
        },
      },
    );

    expect(isStoryDocument(story)).toBe(true);
    const composite = chapter.nodes.find((node) => node.id === "composite-image");
    const references = composite?.type === "image" ? composite.data.images : [];
    expect(resolveStoryImageAssetId(chapter, references[0]!)).toBe("library-image-id");
    expect(resolveStoryImageAssetId(chapter, references[1]!)).toBe("generated-image-id");

    if (composite?.type === "image") composite.data.images = [{ type: "node", nodeId: composite.id }];
    expect(isStoryDocument(story)).toBe(false);

    if (composite?.type === "image") composite.data.images = Array.from({ length: 15 }, () => ({ type: "library", assetId: "reference" }));
    expect(isStoryDocument(story)).toBe(false);
  });

  it("uses Library and generated media nodes as typed video sources", () => {
    const story = createStoryDocument();
    const chapter = story.chapters[0]!;
    chapter.nodes.push(
      { id: "image-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "image-id", mediaType: "image" } },
      { id: "video-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "video-id", mediaType: "video" } },
      { id: "audio-asset", type: "asset", position: { x: 0, y: 0 }, data: { assetId: "audio-id", mediaType: "audio" } },
      {
        id: "video",
        type: "video",
        position: { x: 300, y: 0 },
        data: { prompt: "Animate", model: VIDEO_MODEL, resolution: "720p", aspectRatio: "16:9", duration: 6, references: [{ type: "node", nodeId: "image-asset" }, { type: "node", nodeId: "video-asset" }, { type: "node", nodeId: "audio-asset" }] },
      },
      { id: "scene", type: "scene", position: { x: 600, y: 0 }, data: { title: "Opening", clips: [{ id: "clip", source: { type: "node", nodeId: "video-asset" } }] } },
    );

    expect(isStoryDocument(story)).toBe(true);
    const video = chapter.nodes.find((node) => node.id === "video");
    const scene = chapter.nodes.find((node) => node.id === "scene");
    const references = video?.type === "video" ? video.data.references : [];
    expect(references.map((reference) => resolveStoryAssetId(chapter, reference))).toEqual(["image-id", "video-id", "audio-id"]);
    expect(resolveStoryVideoClipAssetId(chapter, scene?.type === "scene" ? scene.data.clips[0]! : { id: "", source: { type: "library", assetId: "" } })).toBe("video-id");
  });

  it("rejects invalid video generation parameters", () => {
    const story = createStoryDocument();
    story.chapters[0]!.nodes.push({
      id: "video",
      type: "video",
      position: { x: 240, y: 0 },
      data: {
        prompt: "A slow camera move through a forest",
        model: VIDEO_MODEL,
        resolution: "720p",
        aspectRatio: "16:9",
        duration: 6,
        references: [],
      },
    });
    const video = story.chapters[0]!.nodes.at(-1)!;

    (video.data as { duration: number }).duration = 16;

    expect(isStoryDocument(story)).toBe(false);
  });

  it("replaces the existing connection from the same output", () => {
    const edges = [
      { id: "first", source: "choice", sourceHandle: "left", target: "scene-a" },
      { id: "second", source: "choice", sourceHandle: "right", target: "scene-b" },
    ];
    expect(replaceOutgoingEdge(edges, { id: "replacement", source: "choice", sourceHandle: "left", target: "scene-c" }))
      .toEqual([
        { id: "second", source: "choice", sourceHandle: "right", target: "scene-b" },
        { id: "replacement", source: "choice", sourceHandle: "left", target: "scene-c" },
      ]);
  });
});
