import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addPlayableNode } from "../src/daemon/playable-add-node.js";
import {
  createNodeCodebase,
  createPlayableStarterCodebase,
  readNodeCodebase,
} from "../src/daemon/playable-codebase.js";
import { validatePlayableProject } from "../src/daemon/playable-project.js";
import { PLAYABLE_PRESETS, PLAYABLE_PRESET_IDS, playablePreset } from "../src/daemon/playable-presets.js";
import { PLAYABLE_PROJECT_STYLE_FILES } from "../src/daemon/playable-style.js";

async function createWorkspace(name: string): Promise<string> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), `ohmygame-${name}-`));
  await createNodeCodebase(
    workspacePath,
    createPlayableStarterCodebase("Presets", { width: 1280, height: 720 }),
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
      // Declared Signals are the ones the starter source emits, from either file.
      for (const signal of preset.signals) {
        expect(`${source.html}${source.javascript}`).toContain(signal.id);
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
    expect(playablePreset("blank")!.source('<script>"x"').html).toContain(
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
  const source = PLAYABLE_PROJECT_STYLE_FILES["shared/style/components.js"]!;
  const { playScene } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
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
    return { scene, backdrop, emitted, cleanup, skip: scene.children.at(-1)! };
  } finally {
    globalThis.document = previous;
  }
}

describe("playScene", () => {
  it("plays the background video and emits the Signal once when it ends or is skipped", async () => {
    const { backdrop, emitted, skip, cleanup } = await mountScene({ "data-asset": "opening", "data-type": "video" });
    const video = backdrop.children[0]!;
    expect(video).toMatchObject({ tagName: "video", src: "blob:opening" });
    expect(video.loop).toBeUndefined();
    expect(skip.textContent).toBe("Skip");
    video.listeners.get("ended")!();
    skip.listeners.get("click")!();
    expect(emitted).toEqual(["next"]);
    cleanup();
    expect(video.paused).toBe(true);
    expect(video.removed).toBe(true);
    expect(skip.removed).toBe(true);
  });

  it("shows a background image the player continues past", async () => {
    const { backdrop, emitted, skip } = await mountScene({ "data-asset": "still", "data-type": "image" });
    expect(backdrop.children[0]).toMatchObject({ tagName: "img", src: "blob:still" });
    expect(skip.textContent).toBe("Continue");
    skip.listeners.get("click")!();
    expect(emitted).toEqual(["next"]);
  });

  it("asks for media when the background is empty", async () => {
    const { scene, backdrop, skip } = await mountScene({});
    expect(backdrop.children).toEqual([]);
    expect(scene.children[1]).toMatchObject({ tagName: "p", className: "scene-empty", textContent: "Add a video or an image" });
    expect(skip.textContent).toBe("Continue");
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
    expect(codebase.editorLayout.nodes.carriage).toEqual({ x: 80, y: 180 });
    expect(await readFile(path.join(workspacePath, "nodes/carriage/index.html"), "utf8"))
      .toContain("The carriage");
    // The new Node compiles alongside the rest of the project.
    const validation = await validatePlayableProject(workspacePath, "draft");
    expect(validation.issues).toEqual([]);
  });

  it("defaults the title to the Preset label and honours an explicit position", async () => {
    const workspacePath = await createWorkspace("add-node-defaults");

    const result = await addPlayableNode(workspacePath, {
      preset: "ending",
      id: "home",
      position: { x: 900, y: 60 },
    });

    expect(result).toMatchObject({ title: "Ending", signals: [] });
    const codebase = await readNodeCodebase(workspacePath);
    expect(codebase.editorLayout.nodes.home).toEqual({ x: 900, y: 60 });
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
