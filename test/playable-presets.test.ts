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
  listeners = new Map<string, () => void>();
  [key: string]: unknown;
  constructor(readonly tagName: string) {}
  append(...children: FakeElement[]) { this.children.push(...children); }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  removeEventListener(type: string) { this.listeners.delete(type); }
  remove() { this.removed = true; }
  focus() {}
  play() { return Promise.resolve(); }
  pause() { this.paused = true; }
}

async function mountScene(options: Record<string, unknown>) {
  const source = PLAYABLE_PROJECT_STYLE_FILES["shared/style/components.js"]!;
  const { playScene } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag: string) => new FakeElement(tag) } as unknown as Document;
  const root = new FakeElement("main");
  const emitted: string[] = [];
  const context = {
    root,
    assets: { url: (id: string) => `blob:${id}` },
    navigation: { emit: async (signal: string) => { emitted.push(signal); } },
  };
  try {
    const cleanup = playScene(context, options) as () => void;
    const figure = root.children[0]!;
    return { figure, emitted, cleanup, skip: figure.children.at(-1)! };
  } finally {
    globalThis.document = previous;
  }
}

describe("playScene", () => {
  it("plays a video and emits the Signal once when it ends or is skipped", async () => {
    const { figure, emitted, skip, cleanup } = await mountScene({ signal: "next", assetId: "opening" });
    const video = figure.children[0]!;
    expect(video).toMatchObject({ tagName: "video", src: "blob:opening" });
    expect(skip.textContent).toBe("Skip");
    video.listeners.get("ended")!();
    skip.listeners.get("click")!();
    expect(emitted).toEqual(["next"]);
    cleanup();
    expect(video.paused).toBe(true);
    expect(figure.removed).toBe(true);
  });

  it("shows an image the player continues past", async () => {
    const { figure, emitted, skip } = await mountScene({ signal: "next", assetId: "still", type: "image" });
    expect(figure.children[0]).toMatchObject({ tagName: "img", src: "blob:still" });
    expect(skip.textContent).toBe("Continue");
    skip.listeners.get("click")!();
    expect(emitted).toEqual(["next"]);
  });

  it("asks for media when the Scene has none yet", async () => {
    const { figure, skip } = await mountScene({ signal: "next" });
    expect(figure.children[0]).toMatchObject({ tagName: "p", textContent: "Add a video or an image to this Scene." });
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
