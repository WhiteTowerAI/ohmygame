import type { NodeGraph } from "../src/shared/playable-nodes.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PLAYABLE_FIXTURE_FILES = new Set([
  "assets/background.webp",
  "shell/index.html",
  "shell/style.css",
  "shell/shell.js",
  "nodes/menu/index.html",
  "nodes/menu/style.css",
  "nodes/menu/node.js",
  "nodes/lobby/index.html",
  "nodes/lobby/style.css",
  "nodes/lobby/node.js",
  "nodes/archive/index.html",
  "nodes/archive/style.css",
  "nodes/archive/node.js",
]);

export function createNodeGraphFixture(): NodeGraph {
  return {
    version: 1,
    title: "Ash Club",
    viewport: { width: 1280, height: 720 },
    entryNodeId: "menu",
    initialState: { hasKey: false, clues: [], profile: { name: "" } },
    assets: {
      background: {
        type: "image",
        source: { kind: "workspace", path: "assets/background.webp" },
      },
      theme: {
        type: "audio",
        source: { kind: "library", assetId: "library-theme" },
      },
    },
    shell: {
      source: {
        html: "shell/index.html",
        css: "shell/style.css",
        javascript: "shell/shell.js",
      },
      assets: ["theme"],
      signals: [
        { id: "home", label: "Home" },
        { id: "archive", label: "Archive" },
      ],
    },
    nodes: [
      {
        id: "menu",
        title: "Main menu",
        source: {
          html: "nodes/menu/index.html",
          css: "nodes/menu/style.css",
          javascript: "nodes/menu/node.js",
        },
        assets: ["background"],
        signals: [
          { id: "start", label: "Start" },
          { id: "inspect", label: "Inspect archive" },
        ],
      },
      {
        id: "lobby",
        title: "Lobby",
        source: {
          html: "nodes/lobby/index.html",
          css: "nodes/lobby/style.css",
          javascript: "nodes/lobby/node.js",
        },
        assets: [],
        signals: [],
      },
      {
        id: "archive",
        title: "Archive",
        source: {
          html: "nodes/archive/index.html",
          css: "nodes/archive/style.css",
          javascript: "nodes/archive/node.js",
        },
        assets: [],
        signals: [],
      },
    ],
    edges: [
      {
        id: "start-game",
        source: { nodeId: "menu", signal: "start" },
        targetNodeId: "lobby",
        mode: "replace",
      },
      {
        id: "inspect-archive",
        source: { nodeId: "menu", signal: "inspect" },
        targetNodeId: "archive",
        mode: "push",
      },
      {
        id: "shell-home",
        source: { nodeId: "shell", signal: "home" },
        targetNodeId: "menu",
        mode: "replace",
      },
      {
        id: "shell-archive",
        source: { nodeId: "shell", signal: "archive" },
        targetNodeId: "archive",
        mode: "replace",
      },
    ],
  };
}

export async function writePlayableFixtureWorkspace(
  workspace: string,
  graph = createNodeGraphFixture(),
): Promise<void> {
  await Promise.all([
    mkdir(path.join(workspace, "assets"), { recursive: true }),
    mkdir(path.join(workspace, "shell"), { recursive: true }),
    ...graph.nodes.map((node) =>
      mkdir(path.join(workspace, "nodes", node.id), { recursive: true }),
    ),
  ]);
  await Promise.all([
    writeFile(
      path.join(workspace, "graph.json"),
      `${JSON.stringify(graph, null, 2)}\n`,
    ),
    writeFile(path.join(workspace, "assets", "background.webp"), "fixture"),
    writeFile(
      path.join(workspace, "shell", "index.html"),
      "<nav>Shell</nav>\n",
    ),
    writeFile(
      path.join(workspace, "shell", "style.css"),
      "nav { pointer-events: auto; }\n",
    ),
    writeFile(
      path.join(workspace, "shell", "shell.js"),
      "export function mount() {}\n",
    ),
    ...graph.nodes.flatMap((node) => [
      writeFile(
        path.join(workspace, "nodes", node.id, "index.html"),
        `<main>${node.title}</main>\n`,
      ),
      writeFile(
        path.join(workspace, "nodes", node.id, "style.css"),
        "main { display: grid; }\n",
      ),
      writeFile(
        path.join(workspace, "nodes", node.id, "node.js"),
        "export function mount() {}\n",
      ),
    ]),
  ]);
}
