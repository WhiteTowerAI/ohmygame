import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addPlayableNode } from "../src/daemon/playable-add-node.js";
import {
  AGENT_INSTRUCTIONS,
  createNodeCodebase,
  openNodeCodebaseDetail,
  readNodeCodebase,
  writeNodeCodebase,
} from "../src/daemon/playable-codebase.js";
import { buildPlayableProject } from "../src/daemon/playable-project.js";
import { storyWebRuntimeModules } from "../src/daemon/story-web-bundle.js";
import {
  browserImports,
  copyLibraryAssets,
  installStoryRuntime,
  isWebStory,
  libraryAssets,
  STORY_WEB_MANIFEST,
  type StoryWebManifest,
} from "../src/daemon/story-web-project.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

const cleanups: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-story-web-"));
  cleanups.push(directory);
  return directory;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (root: string, relative: string) => readFile(path.join(root, relative), "utf8");
const manifest = async (root: string) => JSON.parse(await read(root, STORY_WEB_MANIFEST)) as StoryWebManifest;

describe("story runtime install", () => {
  it("gives a new project its page and runtime, and leaves a current runtime alone", async () => {
    const root = await workspace();
    await createNodeCodebase(root, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    expect(await isWebStory(root)).toBe(true);
    expect(await read(root, "index.html")).toContain('<script type="module" src="story/story-web/runtime.js"></script>');
    // Saves follow this ID rather than the page's address.
    expect(await read(root, "index.html")).toMatch(/<meta name="ohmygame-story" content="[0-9a-f-]{36}" \/>/);
    const modules = await storyWebRuntimeModules();
    expect(modules["story/shared/playable-video-clip.js"]).toContain("installPlayableVideoClips");
    expect(modules["story/shared/playable-page-host.js"]).toContain("./playable-video-clip.js");
    for (const [relative, content] of Object.entries(modules)) expect(await read(root, relative)).toBe(content);
    expect((await manifest(root)).files).toEqual(Object.fromEntries(Object.entries(modules).map(([relative, content]) => [relative, sha(content)])));
    // The runtime keeps its comments, so whoever changes it can read it.
    expect(await read(root, "story/story-web/runtime.js")).toContain("The story runtime a web story project carries");

    expect(await installStoryRuntime(root)).toEqual({ written: [], pending: [] });
  });

  it("replaces runtime files the author never changed and keeps the ones they did for the Agent to merge", async () => {
    const root = await workspace();
    await createNodeCodebase(root, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    const shipped = await manifest(root);
    // An older runtime: one file as it shipped then, one the author changed since, and one it no longer has.
    await writeFile(path.join(root, "story/shared/playable-graph.js"), "// old graph\n");
    const audio = `${await read(root, "story/shared/playable-audio.js")}\n// the author's change\n`;
    await writeFile(path.join(root, "story/shared/playable-audio.js"), audio);
    await mkdir(path.join(root, "story/shared/old"), { recursive: true });
    await writeFile(path.join(root, "story/shared/old/gone.js"), "// gone\n");
    await writeFile(path.join(root, STORY_WEB_MANIFEST), JSON.stringify({
      version: "older",
      files: {
        ...shipped.files,
        "story/shared/playable-graph.js": sha("// old graph\n"),
        "story/shared/old/gone.js": sha("// gone\n"),
      },
    }));

    const result = await installStoryRuntime(root);
    expect(result.pending).toEqual(["story/shared/playable-audio.js"]);
    expect(result.written).toContain("story/shared/playable-graph.js");
    expect(result.written).toContain("story/shared/old/gone.js");
    expect(await read(root, "story/shared/playable-graph.js")).not.toBe("// old graph\n");
    await expect(read(root, "story/shared/old/gone.js")).rejects.toThrow();
    expect(await read(root, "story/shared/playable-audio.js")).toBe(audio);
    const next = await manifest(root);
    expect(next.version).toBe(shipped.version);
    expect(next.pending).toEqual({ version: shipped.version, files: ["story/shared/playable-audio.js"] });
    // The base the author changed stays recorded, and the newer file waits beside the project.
    expect(next.files["story/shared/playable-audio.js"]).toBe(shipped.files["story/shared/playable-audio.js"]);
    expect(await read(root, `.ohmygame/local/story-runtime/${shipped.version}/story/shared/playable-audio.js`))
      .toBe((await storyWebRuntimeModules())["story/shared/playable-audio.js"]);
  });
});

describe("a web story", () => {
  it("copies the Library assets it still uses into the project, leaving the ones the Library lost", async () => {
    const root = await workspace();
    await createNodeCodebase(root, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    const library = await workspace();
    await writeFile(path.join(library, "lib-video.mp4"), "video bytes");
    const codebase = await readNodeCodebase(root);
    await writeNodeCodebase(root, {
      ...codebase,
      graph: {
        ...codebase.graph,
        assets: {
          ...codebase.graph.assets,
          opening: { type: "video", source: { kind: "library", assetId: "lib-video" } },
          lost: { type: "image", source: { kind: "library", assetId: "lib-missing" } },
        },
      },
    });
    expect(await libraryAssets(root)).toEqual(["opening", "lost"]);

    const result = await copyLibraryAssets(root, async (assetId) => assetId === "lib-video" ? path.join(library, "lib-video.mp4") : undefined);

    expect(result).toEqual({ copiedAssets: ["opening"], missingAssets: ["lost"] });
    expect(await read(root, "assets/library/opening.mp4")).toBe("video bytes");
    const graph = JSON.parse(await read(root, "graph.json"));
    expect(graph.assets.opening.source).toEqual({ kind: "workspace", path: "assets/library/opening.mp4" });
    expect(graph.assets.lost.source).toEqual({ kind: "library", assetId: "lib-missing" });
    await expect(buildPlayableProject(root, "draft")).resolves.toBeDefined();
  });

  it("drops the Story map options Scenes no longer have when the runtime updates, so the story still opens", async () => {
    const root = await workspace();
    await createNodeCodebase(root, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    const graph = JSON.parse(await read(root, "graph.json"));
    graph.nodes[0].story = { hidden: true, label: "Menu" };
    await writeFile(path.join(root, "graph.json"), JSON.stringify(graph));
    // As in a project whose runtime came from an earlier OhMyGame.
    const old = await manifest(root);
    await writeFile(path.join(root, STORY_WEB_MANIFEST), JSON.stringify({ ...old, version: "earlier" }));

    const opened = await openNodeCodebaseDetail(root);

    expect(opened.graph.nodes[0]).not.toHaveProperty("story");
    expect(JSON.parse(await read(root, "graph.json")).nodes[0]).not.toHaveProperty("story");
  });

  it("gives Scenes added to a web story browser imports", async () => {
    const root = await workspace();
    await createNodeCodebase(root, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));
    await addPlayableNode(root, { preset: "visual-novel", id: "chapter-1" });
    expect(await read(root, "nodes/chapter-1/node.js")).toContain('await fetch(new URL("./script.txt", import.meta.url))');
    expect(await read(root, "shared/vn/player.js")).toContain('import characters from "./characters.json" with { type: "json" };');
  });
});

describe("browserImports", () => {
  it("fetches text files and adds the JSON import attribute, leaving other imports alone", () => {
    expect(browserImports([
      'import script from "./script.txt";',
      "import notes from './notes/a.txt'",
      'import data from "./data.json";',
      'import { playScript } from "../../shared/vn/player.js";',
      'import tree from "./tree.json" with { type: "json" };',
    ].join("\n"))).toBe([
      'const script = await (await fetch(new URL("./script.txt", import.meta.url))).text();',
      'const notes = await (await fetch(new URL("./notes/a.txt", import.meta.url))).text();',
      'import data from "./data.json" with { type: "json" };',
      'import { playScript } from "../../shared/vn/player.js";',
      'import tree from "./tree.json" with { type: "json" };',
    ].join("\n"));
  });
});

describe("project guides", () => {
  it("tells the Agent how a web story's runtime and Scenes work", () => {
    expect(AGENT_INSTRUCTIONS).toContain("## Web stories");
    expect(AGENT_INSTRUCTIONS).toContain(".ohmygame/local/story-runtime/<version>/");
  });
});
