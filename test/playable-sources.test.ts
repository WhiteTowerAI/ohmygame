import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPlayableSources } from "../src/daemon/playable-sources.js";
import type { NodeGraph } from "../src/shared/playable-nodes.js";
import { createNodeGraphFixture } from "./playable-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Scene source checks", () => {
  it("accepts Scenes that import shared modules, stylesheets, JSON, and URLs the way a page does", async () => {
    const { workspace, graph } = await sourceWorkspace();
    const result = await checkPlayableSources(workspace, graph);
    expect(result.issues).toEqual([]);
    expect(Object.keys(result.hashes)).toEqual(["menu", "lobby", "archive"]);
    expect(result.hashes.menu).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes a Scene's hash with the files it imports, and only that Scene's", async () => {
    const { workspace, graph } = await sourceWorkspace();
    const before = (await checkPlayableSources(workspace, graph)).hashes;
    await writeFile(path.join(workspace, "shared", "label.js"), 'export const label = "changed";\n');
    const after = (await checkPlayableSources(workspace, graph)).hashes;
    expect(after.menu).not.toBe(before.menu);
    expect(after.lobby).toBe(before.lobby);
    // The viewport and declared Assets are part of what a Scene shows.
    const wider = (await checkPlayableSources(workspace, { ...graph, viewport: { width: 1920, height: 1080 } })).hashes;
    expect(wider.lobby).not.toBe(before.lobby);
  });

  it("checks every Scene and reports the first problem in each", async () => {
    const { workspace, graph } = await sourceWorkspace();
    await writeFile(path.join(workspace, "nodes", "menu", "node.js"), "export function mount( {\n");
    await rm(path.join(workspace, "nodes", "archive", "style.css"));
    const result = await checkPlayableSources(workspace, graph);
    expect(result.issues.map((issue) => [issue.surfaceId, issue.code])).toEqual([
      ["menu", "invalid-source"],
      ["archive", "missing-source"],
    ]);
    expect(result.issues[0]!.message).toMatch(/^nodes\/menu\/node\.js:\d+:\d+: /);
    expect(Object.keys(result.hashes)).toEqual(["lobby"]);
  });

  it.each([
    ['import "tiny-dep";', "has no packages"],
    ['import script from "./script.txt";', 'fetch(new URL("./script.txt", import.meta.url))'],
    ['import data from "./data.json";', 'add with { type: "json" }'],
    ['import { gone } from "./gone.js";', '"./gone.js" imported by "nodes/menu/node.js" is missing'],
  ])("refuses an import a browser cannot load: %s", async (line, message) => {
    const { workspace, graph } = await sourceWorkspace();
    await writeFile(path.join(workspace, "nodes", "menu", "script.txt"), "Hello");
    await writeFile(path.join(workspace, "nodes", "menu", "data.json"), "{}");
    await writeFile(path.join(workspace, "nodes", "menu", "node.js"), `${line}\nexport function mount() {}\n`);
    const [issue] = (await checkPlayableSources(workspace, graph)).issues;
    expect(issue).toMatchObject({ surfaceId: "menu", code: line.includes("gone") ? "missing-source" : "invalid-source" });
    expect(issue!.message).toContain(message);
  });

  it("requires every Scene module to export mount", async () => {
    const { workspace, graph } = await sourceWorkspace();
    await writeFile(path.join(workspace, "nodes", "lobby", "node.js"), "export function start() {}\n");
    expect((await checkPlayableSources(workspace, graph)).issues).toEqual([
      { surfaceId: "lobby", code: "invalid-source", message: "nodes/lobby/node.js must export a mount function." },
    ]);
  });

  it("refuses files outside the project, and stylesheet imports that are missing", async () => {
    const { root, workspace, graph } = await sourceWorkspace();
    await writeFile(path.join(root, "outside.js"), "export function mount() {}\n");
    await rm(path.join(workspace, "nodes", "lobby", "node.js"));
    await symlink(path.join(root, "outside.js"), path.join(workspace, "nodes", "lobby", "node.js"));
    await writeFile(path.join(workspace, "nodes", "archive", "style.css"), '@import "../../shared/gone.css";\n');
    const issues = (await checkPlayableSources(workspace, graph)).issues;
    expect(issues.map((issue) => [issue.surfaceId, issue.code])).toEqual([
      ["lobby", "path-outside-workspace"],
      ["archive", "missing-source"],
    ]);
  });

  it("checks a background video's clip range", async () => {
    const { workspace, graph } = await sourceWorkspace();
    await writeFile(path.join(workspace, "nodes", "menu", "index.html"), '<div data-media="backdrop" data-type="video" data-asset="intro" data-clip-start="3" data-clip-end="2"></div>');
    expect((await checkPlayableSources(workspace, graph)).issues).toEqual([
      expect.objectContaining({ surfaceId: "menu", code: "invalid-video-clip" }),
    ]);
  });
});

/** Three Scenes; the menu imports a shared module, a stylesheet, JSON, and a URL. */
async function sourceWorkspace(): Promise<{ root: string; workspace: string; graph: NodeGraph }> {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-playable-sources-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  const graph = createNodeGraphFixture();
  for (const node of graph.nodes) await mkdir(path.join(workspace, "nodes", node.id), { recursive: true });
  await mkdir(path.join(workspace, "shared"), { recursive: true });
  await writeFile(path.join(workspace, "shared", "label.js"), 'export const label = "shared";\n');
  await writeFile(path.join(workspace, "shared", "theme.css"), '.theme { background: url("./missing-art.webp"); }\n');
  await writeFile(path.join(workspace, "shared", "lines.json"), '["Hello"]\n');
  for (const node of graph.nodes) {
    await writeFile(path.join(workspace, "nodes", node.id, "index.html"), `<main data-node="${node.id}"></main>\n`);
    await writeFile(path.join(workspace, "nodes", node.id, "style.css"), '@import "../../shared/theme.css";\n');
    // In a stylesheet, a path without ./ is still relative to the stylesheet.
    await writeFile(path.join(workspace, "nodes", node.id, "fonts.css"), ".icon { font-family: icons; }\n");
    await writeFile(path.join(workspace, "nodes", node.id, "style.css"), '@import "../../shared/theme.css";\n@import "fonts.css";\n');
    await writeFile(path.join(workspace, "nodes", node.id, "node.js"), "export function mount() {}\n");
  }
  await writeFile(path.join(workspace, "nodes", "menu", "node.js"), [
    'import { label } from "../../shared/label.js";',
    'import lines from "../../shared/lines.json" with { type: "json" };',
    'import confetti from "https://cdn.example.com/confetti.js";',
    "export function mount(context) { context.root.append(label, lines[0], String(confetti)); }",
    "",
  ].join("\n"));
  return { root, workspace, graph };
}
