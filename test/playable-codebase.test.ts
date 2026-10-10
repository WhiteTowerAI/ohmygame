import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeCodebase,
  createPlayableStarterCodebase,
  NodeCodebaseConflictError,
  readNodeCodebase,
  readNodeCodebaseDetail,
  writeNodeCodebase,
} from "../src/daemon/playable-codebase.js";
import { buildPlayableProject } from "../src/daemon/playable-project.js";
import { EDITOR_LAYOUT_SCHEMA } from "../src/shared/editor-layout-schema.js";
import { PLAYABLE_GRAPH_SCHEMA } from "../src/shared/playable-graph-schema.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Playable codebase", () => {
  it("creates a new project with the Project Style and no Scenes yet", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(workspace, createPlayableStarterCodebase("A < B & C", { width: 720, height: 1280 }));

    expect(await tree(workspace)).toEqual([
      "AGENTS.md",
      "README.md",
      "editor/layout.json",
      "graph.json",
      "schemas/editor-layout.schema.json",
      "schemas/graph.schema.json",
      "shared/style/components.css",
      "shared/style/components.js",
      "shared/style/theme.css",
    ]);
    const codebase = await readNodeCodebase(workspace);
    expect(codebase.graph).toMatchObject({ title: "A < B & C", nodes: [], edges: [] });
    expect(codebase.editorLayout.nodes).toEqual({});
    expect(await readJson(workspace, "schemas/graph.schema.json")).toEqual(PLAYABLE_GRAPH_SCHEMA);
    expect(await readJson(workspace, "schemas/editor-layout.schema.json")).toEqual(EDITOR_LAYOUT_SCHEMA);
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8"))
      .toContain("Every Node follows the same protocol");
    expect(await readFile(path.join(workspace, "README.md"), "utf8"))
      .toContain("context.navigation.emit(signalId)");
    // An empty project is a valid draft.
    await expect(buildPlayableProject(workspace, "draft")).resolves.toBeDefined();
  });

  it("writes a starting Scene from the Blank Template", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(workspace, createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }));

    expect(await readFile(path.join(workspace, "nodes/start/index.html"), "utf8"))
      .toContain('<div class="backdrop is-night" data-media="backdrop"></div>');
    // Its `next` Exit goes nowhere yet, which a draft allows.
    await expect(buildPlayableProject(workspace, "draft")).resolves.toBeDefined();
  });

  it("preserves user documentation and refreshes generated schemas", async () => {
    const workspace = await temporaryWorkspace();
    await Promise.all([
      writeFile(path.join(workspace, "README.md"), "User README\n"),
      writeFile(path.join(workspace, "AGENTS.md"), "User agent rules\n"),
      mkdir(path.join(workspace, "schemas")),
    ]);
    await writeFile(path.join(workspace, "schemas/graph.schema.json"), "{}\n");

    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );

    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("User README\n");
    expect(await readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("User agent rules\n");
    expect(await readJson(workspace, "schemas/graph.schema.json")).toEqual(PLAYABLE_GRAPH_SCHEMA);
  });

  it("rejects collisions without changing unrelated workspace files", async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(path.join(workspace, "graph.json"), "existing graph\n");
    await writeFile(path.join(workspace, "notes.txt"), "keep me\n");

    await expect(createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    )).rejects.toThrow("Playable project files already exist: graph.json");

    expect(await readFile(path.join(workspace, "graph.json"), "utf8")).toBe("existing graph\n");
    expect(await readFile(path.join(workspace, "notes.txt"), "utf8")).toBe("keep me\n");
  });

  it("rejects malformed graph files, missing sources, and mismatched layout IDs", async () => {
    const invalidJson = await temporaryWorkspace();
    await Promise.all([
      writeFile(path.join(invalidJson, "graph.json"), "{"),
      mkdir(path.join(invalidJson, "editor")),
    ]);
    await writeFile(path.join(invalidJson, "editor/layout.json"), "{}\n");
    await expect(readNodeCodebase(invalidJson)).rejects.toThrow("graph.json is not valid JSON");

    const missingSource = await temporaryWorkspace();
    await createNodeCodebase(
      missingSource,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    await rm(path.join(missingSource, "nodes/start/node.js"));
    await expect(readNodeCodebase(missingSource)).rejects.toThrow("does not exist");

    const mismatchedLayout = await temporaryWorkspace();
    await createNodeCodebase(
      mismatchedLayout,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const layout = await readJson(mismatchedLayout, "editor/layout.json") as {
      nodes: Record<string, unknown>;
    };
    layout.nodes = { other: { x: 0, y: 0 } };
    await writeFile(
      path.join(mismatchedLayout, "editor/layout.json"),
      `${JSON.stringify(layout)}\n`,
    );
    // A Node added without a position is placed, and a removed Node's position is dropped.
    await expect(readNodeCodebase(mismatchedLayout)).resolves.toMatchObject({
      editorLayout: { nodes: { start: { x: 80, y: 180 } } },
    });
    expect((await readNodeCodebase(mismatchedLayout)).editorLayout.nodes).not.toHaveProperty("other");
  });

  it("updates graph and layout together and rejects invalid changes without writing", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const codebase = await readNodeCodebase(workspace);
    codebase.graph.title = "Revised";
    codebase.editorLayout.nodes.start = { x: 240, y: 320 };
    await writeNodeCodebase(workspace, codebase);
    await expect(readNodeCodebase(workspace)).resolves.toEqual(codebase);

    const graphBefore = await readFile(path.join(workspace, "graph.json"), "utf8");
    const layoutBefore = await readFile(path.join(workspace, "editor/layout.json"), "utf8");
    const invalid = structuredClone(codebase);
    invalid.editorLayout.nodes = {};
    await expect(writeNodeCodebase(workspace, invalid)).rejects.toThrow(
      "Node IDs must exactly match",
    );
    expect(await readFile(path.join(workspace, "graph.json"), "utf8")).toBe(graphBefore);
    expect(await readFile(path.join(workspace, "editor/layout.json"), "utf8")).toBe(layoutBefore);
  });

  it("serializes concurrent reads and writes as complete codebase versions", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Initial", { width: 1280, height: 720 }),
    );
    const initial = await readNodeCodebase(workspace);
    const operations: Array<Promise<void | { title: string; x: number }>> = [];

    for (let index = 1; index <= 20; index += 1) {
      const version = structuredClone(initial);
      version.graph.title = `Version ${index}`;
      version.editorLayout.nodes.start = { x: index, y: 0 };
      operations.push(writeNodeCodebase(workspace, version).then(() => undefined));
      operations.push(readNodeCodebase(workspace).then((codebase) => ({
        title: codebase.graph.title,
        x: codebase.editorLayout.nodes.start!.x,
      })));
    }

    const results = await Promise.all(operations);
    const reads = results.filter((result): result is { title: string; x: number } => result !== undefined);
    expect(reads).toHaveLength(20);
    for (const result of reads) {
      expect(result.title).toBe(`Version ${result.x}`);
    }
    await expect(readNodeCodebase(workspace)).resolves.toMatchObject({
      graph: { title: "Version 20" },
      editorLayout: { nodes: { start: { x: 20, y: 0 } } },
    });
    expect((await tree(workspace)).some((file) => file.includes(".tmp-"))).toBe(false);
  });

  it("refuses to write over a graph that changed on disk since it was read", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const loaded = await readNodeCodebaseDetail(workspace);

    // The Agent edits graph.json with its file tools, which the daemon never sees.
    const agentGraph = structuredClone(loaded.graph);
    agentGraph.title = "Changed by the Agent";
    await writeFile(path.join(workspace, "graph.json"), `${JSON.stringify(agentGraph, null, 2)}\n`);
    const layoutBefore = await readFile(path.join(workspace, "editor/layout.json"), "utf8");

    const stale = structuredClone(loaded);
    stale.editorLayout.nodes.start = { x: 400, y: 400 };
    await expect(writeNodeCodebase(workspace, stale)).rejects.toBeInstanceOf(NodeCodebaseConflictError);
    expect(await readJson(workspace, "graph.json")).toEqual(agentGraph);
    expect(await readFile(path.join(workspace, "editor/layout.json"), "utf8")).toBe(layoutBefore);

    const latest = await readNodeCodebaseDetail(workspace);
    expect(latest.revision).not.toBe(loaded.revision);
    const revision = await writeNodeCodebase(workspace, { ...latest, editorLayout: stale.editorLayout });
    await expect(readNodeCodebaseDetail(workspace)).resolves.toEqual({
      graph: agentGraph,
      editorLayout: stale.editorLayout,
      revision,
    });
  });

  it("writes without a revision whatever the files hold", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const codebase = await readNodeCodebase(workspace);
    await writeNodeCodebase(workspace, { ...codebase, graph: { ...codebase.graph, title: "First" } });

    await writeNodeCodebase(workspace, { ...codebase, graph: { ...codebase.graph, title: "Second" } });

    expect((await readNodeCodebase(workspace)).graph.title).toBe("Second");
  });

  it("creates declared Node source files in the same codebase update", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const codebase = await readNodeCodebase(workspace);
    codebase.graph.nodes.push({
      id: "archive",
      title: "Archive",
      source: {
        html: "nodes/archive/index.html",
        css: "nodes/archive/style.css",
        javascript: "nodes/archive/node.js",
      },
      assets: [],
      signals: [],
    });
    codebase.editorLayout.nodes.archive = { x: 420, y: 180 };

    await writeNodeCodebase(workspace, {
      ...codebase,
      sources: {
        "nodes/archive/index.html": "<main>Archive</main>\n",
        "nodes/archive/style.css": "main { color: white; }\n",
        "nodes/archive/node.js": "export function mount() {}\n",
      },
    });

    expect(await readFile(path.join(workspace, "nodes/archive/index.html"), "utf8")).toBe("<main>Archive</main>\n");
    await expect(readNodeCodebase(workspace)).resolves.toEqual(codebase);
    await expect(buildPlayableProject(workspace, "draft")).resolves.toBeDefined();
  });

  it("rejects undeclared source updates without changing the codebase", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const codebase = await readNodeCodebase(workspace);
    const graphBefore = await readFile(path.join(workspace, "graph.json"), "utf8");

    await expect(writeNodeCodebase(workspace, {
      ...codebase,
      sources: { "shared/undeclared.js": "export const value = true;\n" },
    })).rejects.toThrow("is not declared by a Node");

    expect(await readFile(path.join(workspace, "graph.json"), "utf8")).toBe(graphBefore);
    await expect(readFile(path.join(workspace, "shared/undeclared.js"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source writes through a symlinked workspace directory", async () => {
    const workspace = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    await rm(path.join(workspace, "nodes/start"), { recursive: true });
    await symlink(outside, path.join(workspace, "nodes/start"), "dir");
    const codebase = await readNodeCodebase(workspace).catch(() => (
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 })
    ));

    await expect(writeNodeCodebase(workspace, {
      ...codebase,
      sources: {
        "nodes/start/index.html": "outside html\n",
        "nodes/start/style.css": "outside css\n",
        "nodes/start/node.js": "export function mount() {}\n",
      },
    })).rejects.toThrow("leaves the project workspace");
    await expect(readFile(path.join(outside, "index.html"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes source files and empty directories with a Node deletion", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const codebase = await readNodeCodebase(workspace);
    codebase.graph.nodes.push({
      id: "archive",
      title: "Archive",
      source: { html: "nodes/archive/index.html", css: "nodes/archive/style.css", javascript: "nodes/archive/node.js" },
      assets: [],
      signals: [],
    });
    codebase.editorLayout.nodes.archive = { x: 400, y: 200 };
    const archiveSources = {
      "nodes/archive/index.html": "<main>Archive</main>\n",
      "nodes/archive/style.css": "main {}\n",
      "nodes/archive/node.js": "export function mount() {}\n",
    };
    await writeNodeCodebase(workspace, { ...codebase, sources: archiveSources });

    codebase.graph.nodes = codebase.graph.nodes.filter((node) => node.id !== "archive");
    delete codebase.editorLayout.nodes.archive;
    await writeNodeCodebase(workspace, {
      ...codebase,
      sourceDeletions: Object.keys(archiveSources),
    });

    expect(await tree(workspace)).not.toContain("nodes/archive/index.html");
    await expect(readdir(path.join(workspace, "nodes/archive")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects undeclared and still-declared source deletions", async () => {
    const workspace = await temporaryWorkspace();
    await createNodeCodebase(
      workspace,
      createStarterCodebaseWithScene("Story", { width: 1280, height: 720 }),
    );
    const codebase = await readNodeCodebase(workspace);

    await expect(writeNodeCodebase(workspace, {
      ...codebase,
      sourceDeletions: ["nodes/other/index.html"],
    })).rejects.toThrow("not declared by the current graph");
    await expect(writeNodeCodebase(workspace, {
      ...codebase,
      sourceDeletions: ["nodes/start/index.html"],
    })).rejects.toThrow("still declared by a Node");
    expect(await readFile(path.join(workspace, "nodes/start/index.html"), "utf8"))
      .toContain('data-media="backdrop"');
  });
});

async function temporaryWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-playable-codebase-"));
  temporaryRoots.push(workspace);
  return workspace;
}

async function readJson(workspace: string, relative: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(workspace, relative), "utf8")) as unknown;
}

async function tree(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await tree(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}
