import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { addPlayableNode } from "../src/daemon/playable-add-node.js";
import {
  createNodeCodebase,
  createPlayableStarterCodebase,
  readNodeCodebase,
  writeNodeCodebase,
} from "../src/daemon/playable-codebase.js";
import { validatePlayableProject } from "../src/daemon/playable-project.js";
import { compileNodeGraph } from "../src/daemon/playable-compiler.js";
import { PLAYABLE_PRESETS, PLAYABLE_PRESET_IDS, playablePreset } from "../src/daemon/playable-presets.js";
import { PLAYABLE_PROJECT_STYLE_FILES } from "../src/daemon/playable-style.js";
import { playableBackdrop } from "../src/shared/playable-backdrop.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

/** A project with one Blank Scene, `start`, unless it should be new and empty. */
async function createWorkspace(name: string, empty = false): Promise<string> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), `ohmygame-${name}-`));
  await createNodeCodebase(
    workspacePath,
    empty
      ? createPlayableStarterCodebase("Presets", { width: 1280, height: 720 })
      : createStarterCodebaseWithScene("Presets", { width: 1280, height: 720 }),
  );
  return workspacePath;
}

describe("Playable Presets", () => {
  it("describes every Preset with starter source that imports the Project Style", () => {
    expect(PLAYABLE_PRESETS.map((preset) => preset.id)).toEqual([...PLAYABLE_PRESET_IDS]);
    for (const preset of PLAYABLE_PRESETS) {
      const source = preset.source("Ash Club");
      expect(preset.brief.length).toBeGreaterThan(20);
      expect(preset.summary.length).toBeGreaterThan(10);
      expect(preset.summary.length).toBeLessThan(60);
      expect(source.css).toContain('@import "../../shared/style/components.css";');
      expect(source.javascript).toContain("mount");
      // Every Template has one background the editor can set.
      expect(playableBackdrop(source.html)).toBe("missing");
      expect(source.html).toContain('data-template-artwork="lastbus-');
      for (const [file, css] of Object.entries(preset.sharedFiles ?? {})) {
        if (!file.startsWith("shared/templates/")) continue;
        expect(css).not.toContain("data:image");
        expect(Buffer.byteLength(css)).toBeLessThan(2048);
        expect(css).not.toMatch(/^\.has-backdrop\s*\{/m);
      }
      // Declared Signals are the ones the starter source emits, from any of its files.
      const files = [source.html, source.javascript, ...Object.values(source.files ?? {}), ...Object.values(preset.sharedFiles ?? {})].join("");
      for (const signal of preset.signals) {
        expect(files).toContain(signal.id);
      }
    }
    expect(playablePreset("nope")).toBeUndefined();
  });

  it("has a picture for every Preset in Add a Scene", async () => {
    for (const id of PLAYABLE_PRESET_IDS) {
      await access(path.join(import.meta.dirname, "../src/renderer/assets/templates", `${id}.webp`));
    }
  });

  it("escapes the title in starter HTML", () => {
    expect(playablePreset("ending")!.source('<script>"x"').html).toContain(
      "&lt;script&gt;&quot;x&quot;",
    );
  });
});

/** Just enough DOM for playScene: elements with children, attributes, and listeners. */
class FakeElement {
  children: FakeElement[] = [];
  parentElement?: FakeElement;
  listeners = new Map<string, () => void>();
  [key: string]: unknown;
  constructor(readonly tagName: string, readonly attributes: Record<string, string> = {}) {}
  append(...children: FakeElement[]) {
    for (const child of children) child.parentElement = this;
    this.children.push(...children);
  }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (selector === '[data-media="backdrop"]' && child.attributes["data-media"] === "backdrop") return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  removeEventListener(type: string) { this.listeners.delete(type); }
  remove() { this.removed = true; }
  focus() {}
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
}

/** Mounts a Scene whose background has the given attributes, as the editor writes them. */
async function mountScene(attributes: Record<string, string>) {
  const { playScene } = await loadSceneModule();
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  const root = new FakeElement("root");
  const scene = new FakeElement("main");
  const backdrop = new FakeElement("div", { "data-media": "backdrop", ...attributes });
  scene.append(backdrop);
  root.append(scene);
  const emitted: string[] = [];
  const context = {
    root,
    assets: { url: (id: string) => `blob:${id}` },
    navigation: { emit: async (signal: string) => { emitted.push(signal); } },
  };
  try {
    const cleanup = playScene(context, { signal: "next" }) as () => void;
    return { scene, backdrop, emitted, cleanup, click: () => scene.listeners.get("click")!() };
  } finally {
    globalThis.document = previous;
  }
}

async function loadSceneModule() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-scene-module-"));
  try {
    const file = path.join(directory, "components.mjs");
    await writeFile(file, PLAYABLE_PROJECT_STYLE_FILES["shared/style/components.js"]!);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("playScene", () => {
  it("plays the background video and emits the Signal once when it ends or the player clicks", async () => {
    const { scene, backdrop, emitted, click, cleanup } = await mountScene({ "data-asset": "opening", "data-type": "video" });
    const video = backdrop.children[0]!;
    expect(video).toMatchObject({ tagName: "video", src: "blob:opening" });
    expect(video.loop).toBeUndefined();
    expect(scene.children).toEqual([backdrop]);
    video.listeners.get("ended")!();
    click();
    expect(emitted).toEqual(["next"]);
    cleanup();
    expect(video.paused).toBe(true);
    expect(video.removed).toBe(true);
    expect(scene.listeners.size).toBe(0);
  });

  it("shows a background image the player clicks past", async () => {
    const { backdrop, emitted, click } = await mountScene({ "data-asset": "still", "data-type": "image" });
    expect(backdrop.children[0]).toMatchObject({ tagName: "img", src: "blob:still" });
    click();
    expect(emitted).toEqual(["next"]);
  });

  it("shows nothing over an empty background", async () => {
    const { scene, backdrop } = await mountScene({});
    expect(backdrop.children).toEqual([]);
    expect(scene.children).toEqual([backdrop]);
  });
});

describe("addPlayableNode", () => {
  it("writes the Preset source, Signals, and canvas position", async () => {
    const workspacePath = await createWorkspace("add-node");

    const result = await addPlayableNode(workspacePath, {
      preset: "choice",
      id: "carriage",
      title: "The carriage",
    });

    expect(result).toMatchObject({
      id: "carriage",
      title: "The carriage",
      preset: "choice",
      files: ["nodes/carriage/index.html", "nodes/carriage/style.css", "nodes/carriage/node.js"],
      signals: ["option-a", "option-b"],
    });
    const codebase = await readNodeCodebase(workspacePath);
    expect(codebase.graph.nodes.map((node) => node.id)).toEqual(["start", "carriage"]);
    expect(codebase.graph.nodes[1]).toMatchObject({
      title: "The carriage",
      assets: [],
      signals: [{ id: "option-a" }, { id: "option-b" }],
      source: { html: "nodes/carriage/index.html" },
    });
    // The first slot is under the Scene at (120, 180), so the new one goes beside it.
    expect(codebase.editorLayout.nodes.carriage).toEqual({ x: 560, y: 180 });
    expect(await readFile(path.join(workspacePath, "nodes/carriage/index.html"), "utf8"))
      .toContain("The carriage");
    // Only the chosen Template's picture is copied on first use.
    expect(await readdir(path.join(workspacePath, "shared/templates/lastbus"))).toEqual(["phone.webp"]);
    // The new Node compiles alongside the rest of the project.
    const validation = await validatePlayableProject(workspacePath, "draft");
    expect(validation.issues).toEqual([]);
  });

  it("compiles all eight Templates with bundled artwork and preserves project edits", async () => {
    const workspacePath = await createWorkspace("add-story-map");

    for (const preset of PLAYABLE_PRESETS) {
      await addPlayableNode(workspacePath, { preset: preset.id, id: preset.id });
    }

    const { graph } = await readNodeCodebase(workspacePath);
    const { nodes } = graph;
    expect(nodes.find((node) => node.id === "start")?.story).toBeUndefined();
    expect(nodes.find((node) => node.id === "main-menu")?.story).toEqual({ hidden: true });
    expect(nodes.find((node) => node.id === "story-map")?.story).toEqual({ hidden: true });
    expect((await validatePlayableProject(workspacePath, "draft")).issues).toEqual([]);
    const compiled = await compileNodeGraph(workspacePath, graph);
    for (const id of PLAYABLE_PRESET_IDS) {
      const preset = playablePreset(id)!;
      for (const [relative, css] of Object.entries(preset.sharedFiles ?? {})) {
        if (!relative.startsWith("shared/templates/")) continue;
        const actual = await readFile(path.join(workspacePath, relative), "utf8");
        expect(actual).toBe(css);
        expect(actual).not.toContain("base64");
        const image = actual.match(/url\("(\.\/lastbus\/[^\"]+\.webp)"\)/)![1]!;
        await access(path.resolve(workspacePath, path.dirname(relative), image));
      }
      for (const [relative, bundled] of Object.entries(preset.sharedFileCopies ?? {})) {
        expect(await readFile(path.join(workspacePath, relative))).toEqual(await readFile(bundled));
      }
      // The legacy sandbox build may inline the separate project image for distribution.
      expect(compiled.nodes[id]!.css).toContain("data:image/webp;base64,");
      expect(compiled.nodes[id]!.css).toContain(':not([data-asset])');
    }
    expect(await readdir(path.join(workspacePath, "shared/templates/lastbus"))).toHaveLength(8);

    const illustration = "shared/templates/lastbus-station.css";
    const authored = "/* Author's replacement artwork */\n.backdrop { background: navy; }\n";
    await writeFile(path.join(workspacePath, illustration), authored);
    const imagePath = path.join(workspacePath, "shared/templates/lastbus/station.webp");
    const replacement = await readFile(path.join(workspacePath, "shared/templates/lastbus/cover.webp"));
    await writeFile(imagePath, replacement);
    const existingScene = await readFile(path.join(workspacePath, "nodes/story-map/style.css"), "utf8");
    await addPlayableNode(workspacePath, { preset: "visual-novel", id: "chapter-2" });
    expect(await readFile(path.join(workspacePath, illustration), "utf8")).toBe(authored);
    expect(await readFile(imagePath)).toEqual(replacement);
    expect(await readFile(path.join(workspacePath, "nodes/story-map/style.css"), "utf8")).toBe(existingScene);
  });

  it("gives a Main menu a Story map Exit that waits to be connected", async () => {
    const workspacePath = await createWorkspace("menu-story-map");

    await addPlayableNode(workspacePath, { preset: "main-menu", id: "menu" });

    const { graph } = await readNodeCodebase(workspacePath);
    expect(graph.nodes.find((node) => node.id === "menu")?.signals).toContainEqual({ id: "story-map", label: "Story map", role: "navigation" });
    expect(graph.edges.some((edge) => edge.source.nodeId === "menu")).toBe(false);
  });

  it("names the Node in order and honours an explicit position", async () => {
    const workspacePath = await createWorkspace("add-node-defaults");

    const result = await addPlayableNode(workspacePath, {
      preset: "ending",
      id: "home",
      position: { x: 900, y: 60 },
    });

    expect(result).toMatchObject({ title: "Node 2", signals: [] });
    const codebase = await readNodeCodebase(workspacePath);
    expect(codebase.editorLayout.nodes.home).toEqual({ x: 900, y: 60 });
  });

  it("makes the first Node of an empty project its Start", async () => {
    const workspacePath = await createWorkspace("add-node-empty", true);
    expect((await validatePlayableProject(workspacePath, "draft")).issues).toEqual([]);

    await addPlayableNode(workspacePath, { preset: "main-menu", id: "menu" });

    const next = await readNodeCodebase(workspacePath);
    expect(next.graph.entryNodeId).toBe("menu");
    expect((await validatePlayableProject(workspacePath, "draft")).issues).toEqual([]);
  });

  it("rejects an unknown Preset, a bad ID, and a duplicate Node", async () => {
    const workspacePath = await createWorkspace("add-node-errors");

    await expect(addPlayableNode(workspacePath, { preset: "epilogue", id: "a" }))
      .rejects.toThrow(/Unknown Preset "epilogue"/);
    await expect(addPlayableNode(workspacePath, { preset: "blank", id: "../escape" }))
      .rejects.toThrow(/Invalid Node ID/);
    await expect(addPlayableNode(workspacePath, { preset: "blank", id: "start" }))
      .rejects.toThrow(/already exists/);
  });
});
