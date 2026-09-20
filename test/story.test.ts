import { describe, expect, it } from "vitest";
import { VIDEO_MODEL, type StoryChapter, type StoryDocument, type StoryNode } from "../src/shared/contracts.js";
import { createInteractiveDramaStarterStory } from "../src/shared/interactive-drama-starter.js";
import {
  advanceOpenUi, applyStoryActions, chooseOption, completeSceneMedia, createPlayerState, createStoryDocument, defaultStoryNodeSource, getNextNode,
  getStartNode, isEntryOpenUiNode, isStoryDocument, normalizeStoryActions, normalizeStoryVariableReferences,
  parseStoryDocument, replaceOutgoingEdge, resolveInteractionNode, resolvePresentationMedia, resolveStoryAssetId,
  restartGame, storyNodePresentation, validatePlayableChapter,
  transparentStorySurfaceFiles,
} from "../src/shared/story.js";
import { createPlayableStoryDocument } from "./story-fixture.js";

describe("canonical Interactive Drama story", () => {
  it("creates a valid blank story document", () => {
    const story = createStoryDocument();
    expect(story.chapter).toMatchObject({ nodes: [], edges: [] });
    expect(story.editorLayout.nodes).toEqual({});
    expect(isStoryDocument(story)).toBe(true);
  });

  it("derives stable source paths for presentation nodes", () => {
    expect(defaultStoryNodeSource("Scene One")).toEqual({
      html: "nodes/scene-one-4ott8j/index.html",
      css: "nodes/scene-one-4ott8j/style.css",
      javascript: "nodes/scene-one-4ott8j/script.js",
    });
    expect(defaultStoryNodeSource("Scene One")).toEqual(defaultStoryNodeSource("Scene One"));
    expect(defaultStoryNodeSource("!!!").html).toMatch(/^nodes\/definition-[a-z0-9]+\/index\.html$/);
  });

  it("creates a complete Start -> Open UI -> Ending graph", () => {
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const start = getStartNode(chapter)!;
    const openUi = getNextNode(chapter, start.id)!;
    expect(openUi.type).toBe("open-ui");
    expect(getNextNode(chapter, openUi.id)?.type).toBe("ending");
    expect(isStoryDocument(story)).toBe(true);
    expect(validatePlayableChapter(chapter)).toBeUndefined();
  });

  it("recognizes only the Open UI connected directly after Start as the entry UI", () => {
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const entry = chapter.nodes.find((node) => node.type === "open-ui")!;
    const midFlow = structuredClone(entry);
    midFlow.id = "mid-flow-ui";
    chapter.nodes.push(midFlow);

    expect(isEntryOpenUiNode(chapter, entry.id)).toBe(true);
    expect(isEntryOpenUiNode(chapter, midFlow.id)).toBe(false);
  });

  it("keeps presentation surfaces transparent", () => {
    const files = { html: "<main></main>", css: "main { background: red; }", javascript: "export function render() {}" };
    const result = transparentStorySurfaceFiles(files);

    expect(result).not.toBe(files);
    expect(result.css).toBe(`${files.css}\nhtml,body{background:transparent!important}`);
    expect(transparentStorySurfaceFiles(files, ".open-ui").css).toBe(`${files.css}\nhtml,body,.open-ui{background:transparent!important}`);
  });

  it("allows incomplete editing state but rejects more than one Start", () => {
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const ending = chapter.nodes.find((node) => node.type === "ending")!;
    chapter.nodes = chapter.nodes.filter((node) => node.id !== ending.id);
    chapter.edges = chapter.edges.filter((edge) => edge.source !== ending.id && edge.target !== ending.id);
    delete story.editorLayout.nodes[ending.id];
    expect(isStoryDocument(story)).toBe(true);

    const second = createPlayableStoryDocument();
    const secondChapter = second.chapter;
    secondChapter.nodes.push({ id: "second-start", type: "start", position: { x: 0, y: 0 }, data: {} });
    second.editorLayout.nodes["second-start"] = { x: 0, y: 0 };
    expect(isStoryDocument(second)).toBe(false);
  });

  it("rejects old document versions instead of migrating them", () => {
    expect(() => parseStoryDocument({ ...createPlayableStoryDocument(), version: 8 })).toThrow("Invalid story document");
    expect(() => parseStoryDocument({ ...createPlayableStoryDocument(), chapters: [] })).toThrow("Invalid story document");
  });

  it("rejects legacy and unknown fields instead of normalizing them", () => {
    expect(isStoryDocument({ ...createPlayableStoryDocument(), overlays: [] })).toBe(false);
    const { player: _player, ...withoutPlayer } = createPlayableStoryDocument();
    expect(isStoryDocument(withoutPlayer)).toBe(false);
    const story = createPlayableStoryDocument();
    const ending = story.chapter.nodes.find((node) => node.type === "ending")!;
    ending.data = { ...ending.data, overlayIds: [] } as typeof ending.data;
    expect(isStoryDocument(story)).toBe(false);

    const legacyState = createPlayableStoryDocument();
    legacyState.chapter.nodes.push({ id: "legacy", type: "project-state", position: { x: 0, y: 0 }, data: { title: "Initial State", actions: [] } } as unknown as StoryNode);
    legacyState.editorLayout.nodes.legacy = { x: 0, y: 0 };
    expect(isStoryDocument(legacyState)).toBe(false);
  });

  it("requires non-empty unique variable names", () => {
    const story = createPlayableStoryDocument();
    story.variables = [
      { id: "one", name: "score", type: "number", initialValue: 0 },
      { id: "two", name: "score", type: "number", initialValue: 1 },
    ];
    expect(isStoryDocument(story)).toBe(false);
    story.variables[1]!.name = "";
    expect(isStoryDocument(story)).toBe(false);
    story.variables[1]!.name = "   ";
    expect(isStoryDocument(story)).toBe(false);
    story.variables[1]!.name = "courage";
    expect(isStoryDocument(story)).toBe(true);
  });

  it("ships a starter whose visible nodes own media and code", () => {
    const story = createInteractiveDramaStarterStory({ videoId: "video" }, "Midnight Run");
    const visible = story.chapter.nodes.filter(isVisibleNode);
    expect("interactions" in story).toBe(false);
    expect("overlays" in story).toBe(false);
    expect("playerViews" in story).toBe(false);
    expect(visible.every((node) => Boolean(storyNodePresentation(node).surface.files.javascript))).toBe(true);
    expect(story.chapter.nodes.find((node) => node.type === "open-ui")?.data.title).toBe("Midnight Run");
    const stateNodes = story.chapter.nodes.filter((node): node is Extract<StoryNode, { type: "update-state" }> => node.type === "update-state");
    expect(stateNodes.map((node) => node.data.actions[0])).toEqual([
      { type: "update-variable", variableId: story.variables[0]!.id, operator: "add", value: 1 },
      { type: "update-variable", variableId: story.variables[0]!.id, operator: "subtract", value: 1 },
    ]);
    const choice = story.chapter.nodes.find((node): node is Extract<StoryNode, { type: "choice" }> => node.type === "choice")!;
    expect(choice.data.options.every((option) => !option.actions)).toBe(true);
    expect(choice.data.options.map((option) => getNextNode(story.chapter, choice.id, option.id)?.type)).toEqual(["update-state", "update-state"]);
    expect(stateNodes.map((node) => getNextNode(story.chapter, node.id)?.type)).toEqual(["ending", "ending"]);
    expect(getNextNode(story.chapter, story.chapter.nodes.find((node) => node.type === "open-ui")!.id)?.type).toBe("scene");
    expect(isStoryDocument(story)).toBe(true);
  });

  it("requires Interaction nodes to declare unique outcomes instead of a fixed behavior type", () => {
    const story = createInteractiveDramaStarterStory({ videoId: "video" });
    const interaction = story.chapter.nodes.find((node): node is Extract<StoryNode, { type: "interaction" }> => node.type === "interaction")!;
    interaction.data.outcomes = ["custom", "custom"];
    expect(isStoryDocument(story)).toBe(false);

    interaction.data.outcomes = ["custom"];
    interaction.data = { ...interaction.data, behavior: { type: "hotspot" } } as typeof interaction.data;
    expect(isStoryDocument(story)).toBe(false);
  });

  it("validates Interaction time limits against their declared outcomes", () => {
    const story = createInteractiveDramaStarterStory({ videoId: "video" });
    const interaction = story.chapter.nodes.find((node): node is Extract<StoryNode, { type: "interaction" }> => node.type === "interaction")!;
    expect(interaction.data.timeout).toEqual({ durationMs: 3_000, outcome: "timeout" });
    expect(isStoryDocument(story)).toBe(true);

    interaction.data.timeout = { durationMs: 999, outcome: "timeout" };
    expect(isStoryDocument(story)).toBe(false);
    interaction.data.timeout = { durationMs: 300_001, outcome: "timeout" };
    expect(isStoryDocument(story)).toBe(false);
    interaction.data.timeout = { durationMs: 3_000, outcome: "missing" };
    expect(isStoryDocument(story)).toBe(false);
    interaction.data.timeout = { durationMs: 3_000, outcome: "timeout", extra: true } as typeof interaction.data.timeout;
    expect(isStoryDocument(story)).toBe(false);
  });

  it("runs Interaction code commands and graph outcomes", () => {
    const story = createInteractiveDramaStarterStory({ videoId: "video" });
    const chapter = story.chapter;
    let state = restartGame(chapter, story.variables);
    state = advanceOpenUi(chapter, state);
    const scene = chapter.nodes.find((node) => node.id === state.nodeId && node.type === "scene")!;
    state = { ...state, nodeId: getNextNode(chapter, scene.id)!.id, scenePlayback: undefined };
    const interaction = chapter.nodes.find((node): node is Extract<StoryNode, { type: "interaction" }> => node.id === state.nodeId && node.type === "interaction")!;
    expect(interaction.data.outcomes).toEqual(["success", "timeout"]);
    state = resolveInteractionNode(chapter, state, "success", [
      { type: "set-variable", variable: "Found ticket", value: true },
      { type: "increment-variable", variable: "Courage", amount: 1 },
    ], story.variables);
    expect(Object.values(state.variables)).toContain(true);
    expect(state.variables[story.variables.find((variable) => variable.name === "Courage")!.id]).toBe(3);
  });

  it("applies Update State actions while advancing through the flow", () => {
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const openUi = chapter.nodes.find((node) => node.type === "open-ui")!;
    const ending = chapter.nodes.find((node) => node.type === "ending")!;
    const stateNode: StoryNode = { id: "update", type: "update-state", position: { x: 500, y: 0 }, data: { title: "Raise score", actions: [] } };
    chapter.nodes.push(stateNode);
    chapter.edges = chapter.edges.filter((edge) => edge.source !== openUi.id);
    chapter.edges.push({ id: "open-update", source: openUi.id, target: stateNode.id }, { id: "update-ending", source: stateNode.id, target: ending.id });
    story.editorLayout.nodes[stateNode.id] = stateNode.position;
    const variable = { id: "score", name: "Score", type: "number" as const, initialValue: 1 };
    story.variables = [variable];
    stateNode.data.actions = [{ type: "update-variable", variableId: variable.id, operator: "add", value: 2 }];

    let runtime = restartGame(chapter, story.variables);
    runtime = advanceOpenUi(chapter, runtime);

    expect(runtime.variables[variable.id]).toBe(3);
    expect(runtime.nodeId).toBe(chapter.nodes.find((node) => node.type === "ending")?.id);
  });

  it("carries presentation media along the path actually played", () => {
    const variables: StoryDocument["variables"] = [];
    const start: StoryNode = { id: "start", type: "start", position: { x: 0, y: 0 }, data: {} };
    const initial: StoryNode = { id: "state", type: "update-state", position: { x: 100, y: 0 }, data: { title: "State", actions: [] } };
    const scene: StoryNode = { id: "scene", type: "scene", position: { x: 200, y: 0 }, data: { title: "Scene", presentation: { media: { mode: "own", items: [{ id: "image", type: "image", source: { type: "library", assetId: "image-asset" } }] }, surface: inheritedPresentation().surface } } };
    const interaction: StoryNode = { id: "interaction", type: "interaction", position: { x: 300, y: 0 }, data: { title: "Continue", outcomes: ["continue"], presentation: inheritedPresentation() } };
    const ending: StoryNode = { id: "ending", type: "ending", position: { x: 400, y: 0 }, data: { title: "End", description: "", presentation: inheritedPresentation() } };
    const chapter: StoryChapter = {
      id: "chapter", title: "Chapter", nodes: [start, initial, scene, interaction, ending],
      edges: [
        { id: "a", source: start.id, target: initial.id },
        { id: "b", source: initial.id, target: scene.id },
        { id: "c", source: scene.id, target: interaction.id },
        { id: "d", source: interaction.id, sourceHandle: "continue", target: ending.id },
      ],
    };
    let state = restartGame(chapter, variables);
    state = completeSceneMedia(chapter, state, "image", 0);
    expect(state.nodeId).toBe(interaction.id);
    expect(resolvePresentationMedia(chapter, state)).toEqual(scene.data.presentation.media.mode === "own" ? scene.data.presentation.media.items[0] : undefined);
    state = resolveInteractionNode(chapter, state, "continue", [], variables);
    expect(resolvePresentationMedia(chapter, state)?.id).toBe("image");
  });

  it("validates image and video presentation media by their actual type", () => {
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    const openUi = chapter.nodes.find((node) => node.type === "open-ui")!;
    const ending = chapter.nodes.find((node) => node.type === "ending")!;
    const image: StoryNode = { id: "image", type: "asset", position: { x: 200, y: 0 }, data: { assetId: "poster", mediaType: "image" } };
    const scene: StoryNode = { id: "scene", type: "scene", position: { x: 300, y: 0 }, data: { title: "Poster", presentation: { media: { mode: "own", items: [{ id: "poster-item", type: "image", source: { type: "node", nodeId: image.id } }] }, surface: inheritedPresentation().surface } } };
    chapter.nodes.push(image, scene);
    chapter.edges = chapter.edges.filter((edge) => edge.source !== openUi.id);
    chapter.edges.push({ id: "open-scene", source: openUi.id, target: scene.id }, { id: "scene-ending", source: scene.id, target: ending.id });
    expect(validatePlayableChapter(chapter, { availableAssets: new Map([["poster", "image"]]) })).toBeUndefined();
    expect(validatePlayableChapter(chapter, { availableAssets: new Map([["poster", "video"]]) })?.nodeId).toBe(scene.id);
  });

  it("requires globally unique node IDs and complete exact editor layout", () => {
    const missingLayout = createPlayableStoryDocument();
    delete missingLayout.editorLayout.nodes[missingLayout.chapter.nodes[0]!.id];
    expect(isStoryDocument(missingLayout)).toBe(false);

    const duplicate = createPlayableStoryDocument();
    duplicate.chapter.nodes.push({ ...duplicate.chapter.nodes[0]!, id: duplicate.chapter.nodes[1]!.id });
    expect(isStoryDocument(duplicate)).toBe(false);
  });

  it("rejects multiple owned media items outside Scene nodes", () => {
    const story = createPlayableStoryDocument();
    const ending = story.chapter.nodes.find((node) => node.type === "ending")!;
    if (ending.type !== "ending") throw new Error("Ending is missing");
    ending.data.presentation.media = { mode: "own", items: [
      { id: "one", type: "image", source: { type: "library", assetId: "one" } },
      { id: "two", type: "image", source: { type: "library", assetId: "two" } },
    ] };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("resolves canonical presentation media through Library and media nodes", () => {
    const story = createPlayableStoryDocument();
    const chapter = story.chapter;
    chapter.nodes.push({ id: "video", type: "video", position: { x: 0, y: 0 }, data: { prompt: "", model: VIDEO_MODEL, resolution: "720p", aspectRatio: "adaptive", duration: 6, references: [], assetId: "generated" } });
    expect(resolveStoryAssetId(chapter, { type: "library", assetId: "library" })).toBe("library");
    expect(resolveStoryAssetId(chapter, { type: "node", nodeId: "video" })).toBe("generated");
  });

  it("normalizes Choice references when variables are removed or retyped", () => {
    const options = [{ id: "go", label: "Go", condition: { variableId: "score", operator: "greater-than" as const, value: 1 }, actions: [{ type: "update-variable" as const, variableId: "score", operator: "add" as const, value: 2 }] }];
    expect(normalizeStoryVariableReferences(options, new Map())).toEqual([{ id: "go", label: "Go" }]);
    const normalized = normalizeStoryVariableReferences(options, new Map([["score", { id: "score", name: "score", type: "text", initialValue: "" }]]));
    expect(normalized[0]).toMatchObject({ condition: { operator: "equals", value: "" } });
    expect(normalized[0]!.actions).toBeUndefined();
  });

  it("normalizes Update State actions when variables are removed or retyped", () => {
    const actions = [
      { type: "update-variable" as const, variableId: "score", operator: "set" as const, value: 1 },
      { type: "update-variable" as const, variableId: "score", operator: "add" as const, value: 2 },
    ];
    expect(normalizeStoryActions(actions, new Map())).toEqual([]);
    expect(normalizeStoryActions(actions, new Map([["score", { id: "score", name: "score", type: "text", initialValue: "" }]]))).toEqual([
      { type: "update-variable", variableId: "score", operator: "set", value: "" },
    ]);
  });

  it("applies choice actions and follows the selected output", () => {
    const variables = [{ id: "score", name: "score", type: "number" as const, initialValue: 0 }];
    const choice: StoryNode = { id: "choice", type: "choice", position: { x: 0, y: 0 }, data: { title: "Choose", options: [{ id: "go", label: "Go", actions: [{ type: "update-variable", variableId: "score", operator: "add", value: 2 }] }], presentation: inheritedPresentation() } };
    const ending: StoryNode = { id: "ending", type: "ending", position: { x: 0, y: 0 }, data: { title: "End", description: "", presentation: inheritedPresentation() } };
    const chapter: StoryChapter = { id: "chapter", title: "Chapter", nodes: [choice, ending], edges: [{ id: "edge", source: "choice", sourceHandle: "go", target: "ending" }] };
    const state = { ...createPlayerState(chapter.id, variables), mode: "playing" as const, nodeId: choice.id };
    expect(chooseOption(chapter, state, "go")).toMatchObject({ nodeId: "ending", variables: { score: 2 } });
    expect(applyStoryActions(choice.data.options[0]!.actions, { score: 1 })).toEqual({ score: 3 });
  });

  it("applies every Update State operator", () => {
    expect(applyStoryActions([
      { type: "update-variable", variableId: "score", operator: "add", value: 3 },
      { type: "update-variable", variableId: "score", operator: "subtract", value: 1 },
      { type: "update-variable", variableId: "score", operator: "multiply", value: 4 },
      { type: "update-variable", variableId: "score", operator: "divide", value: 2 },
      { type: "update-variable", variableId: "label", operator: "set", value: "ready" },
    ], { score: 2, label: "waiting" })).toEqual({ score: 8, label: "ready" });
    expect(() => applyStoryActions([
      { type: "update-variable", variableId: "score", operator: "divide", value: 0 },
    ], { score: 2 })).toThrow("Variable result is not finite: score");
  });

  it("rejects division by zero before playtest", () => {
    const story = createPlayableStoryDocument();
    const variable = { id: "score", name: "Score", type: "number" as const, initialValue: 1 };
    story.variables = [variable];
    story.chapter.nodes.push({
      id: "invalid-update",
      type: "update-state",
      position: { x: 0, y: 0 },
      data: { title: "Invalid update", actions: [{ type: "update-variable", variableId: variable.id, operator: "divide", value: 0 }] },
    });
    story.editorLayout.nodes["invalid-update"] = { x: 0, y: 0 };
    expect(isStoryDocument(story)).toBe(false);
  });

  it("replaces only the matching output edge", () => {
    const edges = [{ id: "a", source: "choice", sourceHandle: "left", target: "one" }, { id: "b", source: "choice", sourceHandle: "right", target: "two" }];
    expect(replaceOutgoingEdge(edges, { id: "c", source: "choice", sourceHandle: "left", target: "three" })).toEqual([
      edges[1], { id: "c", source: "choice", sourceHandle: "left", target: "three" },
    ]);
  });
});

function isVisibleNode(node: StoryNode): node is Extract<StoryNode, { type: "open-ui" | "scene" | "interaction" | "choice" | "ending" }> {
  return node.type === "open-ui" || node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

function inheritedPresentation() {
  return { media: { mode: "inherit" as const }, surface: { files: { html: "<main></main>", css: "", javascript: "export function render() {}" } } };
}
