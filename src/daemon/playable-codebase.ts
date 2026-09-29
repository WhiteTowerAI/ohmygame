import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EDITOR_LAYOUT_SCHEMA } from "../shared/editor-layout-schema.js";
import { PLAYABLE_GRAPH_SCHEMA } from "../shared/playable-graph-schema.js";
import { validateNodeGraph } from "../shared/playable-graph-validation.js";
import {
  isNodeEditorLayout,
  playableLayoutMatchesGraph,
  type NodeCodebase,
  type NodeCodebaseUpdate,
  type NodeEditorLayout,
} from "../shared/playable-codebase.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import { PLAYABLE_PROJECT_STYLE_FILES } from "./playable-style.js";
import { listWorkspaceFiles } from "./workspace.js";

const GRAPH_FILE = "graph.json";
const LAYOUT_FILE = "editor/layout.json";
const GRAPH_SCHEMA_FILE = "schemas/graph.schema.json";
const LAYOUT_SCHEMA_FILE = "schemas/editor-layout.schema.json";
const codebaseOperations = new Map<string, Promise<void>>();

export class NodeCodebaseError extends Error {
  override readonly name = "NodeCodebaseError";
}

const AGENT_INSTRUCTIONS = `# Playable Nodes Project

This workspace is the source of truth for an OhMyGame Playable Nodes project.

- \`graph.json\` declares the viewport, initial State, Assets, optional Shell, Nodes, Signals, and navigation edges.
- Every Node follows the same protocol. Its HTML, CSS, and JavaScript are ordinary source files referenced by \`node.source\`.
- Node JavaScript exports \`mount(context)\`. Render into \`context.root\` and optionally return a cleanup function.
- Emit only Signals declared by the current Node: \`context.navigation.emit(signalId)\`. Signals describe outcomes; they do not name target Nodes.
- Read and update authoritative project State through \`context.state\`. Do not keep navigation-critical state only in the DOM.
- A Node may use only Assets listed in its \`assets\` array. Resolve them with \`context.assets.url(assetId)\`.
- Build every screen with the Project Style in \`shared/style/\`: import \`shared/style/components.css\` from a Node's CSS and use its tokens and classes. Add a token or component there instead of hard-coding values in a Node, and restyle the game by changing \`shared/style/\` first.
- \`shared/style/components.js\` exports \`playCinematic(context, { assetId, signal })\`, which plays a declared video, offers skip, and emits the Signal when it ends or is skipped. Cinematic behaviour is Node content, so change it freely.
- Use normal modules under \`shared/\` for code shared by Nodes. Imports must remain inside this workspace; project dependencies resolve from this project's own \`node_modules\`.
- The optional Shell is persistent project UI. Use it only for controls or presentation that truly continue across Node changes. The Shell declares its own \`signals\` and emits them like a Node; edges from the Shell use \`"shell"\` as their source \`nodeId\`, so no Node may use that ID.
- Use \`replace\` for forward progression and \`push\` only when the player should be able to return with \`navigation.back()\`.
- Keep IDs and source paths stable when editing existing objects. Keep \`editor/layout.json\` synchronized with the exact Node IDs in \`graph.json\`.
- Read \`README.md\` and the schemas in \`schemas/\` before changing the contract. Do not copy or modify the OhMyGame Runtime inside this project.

## Words the editor uses

The user sees the editor, not this contract. Talk to them in its words:

| Editor | Contract |
| --- | --- |
| Scene | Node |
| Exit | Signal and the edge that routes it |
| Start | \`entryNodeId\` |
| Overlay | Shell |
| Variables | \`initialState\` and the live State |
| Allow Back | edge \`mode: "push"\` |
| Template | Preset |
`;

const PROJECT_DOCUMENTATION = `# Playable Nodes Project

This project is made of one graph plus ordinary browser source files. Every Node has the same capabilities; names such as menu, scene, archive, or puzzle are authoring ideas rather than runtime types.

## Files

- \`graph.json\` is the runtime graph and dependency manifest.
- \`nodes/<id>/\` contains a Node's HTML, CSS, and JavaScript.
- \`shell/\` contains optional persistent UI.
- \`shared/\` contains ordinary modules imported by more than one surface.
- \`shared/style/\` is the Project Style: \`theme.css\` tokens, \`components.css\` classes, and \`components.js\` components such as \`playCinematic()\`.
- \`editor/layout.json\` contains editor-only positions and viewport state.
- \`schemas/\` contains the exact persisted JSON contracts.
- \`.ohmygame/\` is editor cache, such as Node thumbnails. It is never published; leave it alone.

## Node API

Each Node module exports \`mount(context)\`. The Runtime supplies:

- \`context.root\`: the Node's isolated ShadowRoot.
- \`context.assets.url(id)\`: a URL for an Asset declared by this Node.
- \`context.state.get(key)\`, \`set(key, value)\`, \`patch(values)\`, and \`subscribe(listener)\`.
- \`context.navigation.emit(signalId)\` and \`back()\`.
- \`context.session.hasSave()\`, \`save()\`, \`continue()\`, \`restart()\`, and \`reset()\`.
- \`context.lifecycle.signal\`: aborted before cleanup when the Node exits.

The optional Shell exports the same \`mount(context)\` function and receives the same context. It emits the Signals declared in \`graph.shell.signals\`; edges route them from the source \`nodeId\` \`"shell"\`. Shell CSS should enable pointer events only on interactive Shell elements.

The mount function may return a synchronous or asynchronous cleanup function. Source may import local Shared Modules and dependencies declared by this project. Network access is unavailable at runtime.
`;

export function createPlayableStarterCodebase(
  title: string,
  viewport: { width: number; height: number },
  template: "blank" | "night-train" = "blank",
): NodeCodebase {
  return template === "night-train"
    ? nightTrainCodebase(title, viewport)
    : blankCodebase(title, viewport);
}

export async function createNodeCodebase(
  workspacePath: string,
  codebase: NodeCodebase,
): Promise<void> {
  await withCodebaseLock(workspacePath, async () => {
    await validateCodebase(workspacePath, codebase, false);
    const sources = starterSources(codebase.graph);
    const generatedFiles = [GRAPH_FILE, LAYOUT_FILE, ...Object.keys(sources)];
    const collisions = await existingGeneratedFiles(workspacePath, [
      ...generatedFiles,
    ]);
    if (collisions.length) {
      throw new NodeCodebaseError(
        `Playable project files already exist: ${collisions.join(", ")}`,
      );
    }
    const touchedFiles = [
      ...generatedFiles,
      "AGENTS.md",
      "README.md",
      GRAPH_SCHEMA_FILE,
      LAYOUT_SCHEMA_FILE,
    ];
    const snapshot = await snapshotFiles(workspacePath, touchedFiles);
    try {
      for (const file of generatedFiles) {
        await mkdir(path.dirname(path.join(workspacePath, file)), { recursive: true });
      }
      await writeJson(path.join(workspacePath, GRAPH_FILE), codebase.graph, "wx");
      await writeJson(path.join(workspacePath, LAYOUT_FILE), codebase.editorLayout, "wx");
      for (const [file, content] of Object.entries(sources)) {
        await writeFile(path.join(workspacePath, file), content, {
          encoding: "utf8",
          flag: "wx",
        });
      }
      await ensureNodeCodebaseContract(workspacePath);
    } catch (cause) {
      await restoreFiles(workspacePath, snapshot);
      throw cause;
    }
  });
}

export async function readNodeCodebase(
  workspacePath: string,
): Promise<NodeCodebase> {
  return withCodebaseLock(workspacePath, async () => {
    const [graphValue, layoutValue] = await Promise.all([
      readJson(path.join(workspacePath, GRAPH_FILE), GRAPH_FILE),
      readJson(path.join(workspacePath, LAYOUT_FILE), LAYOUT_FILE),
    ]);
    const codebase = {
      graph: graphValue as NodeGraph,
      editorLayout: layoutValue as NodeEditorLayout,
    };
    await validateCodebase(workspacePath, codebase, true);
    return codebase;
  });
}

export async function writeNodeCodebase(
  workspacePath: string,
  update: NodeCodebaseUpdate,
): Promise<void> {
  await withCodebaseLock(workspacePath, async () => {
    const codebase: NodeCodebase = {
      graph: update.graph,
      editorLayout: update.editorLayout,
    };
    const sources = validateSourceUpdates(codebase.graph, update.sources);
    const sourceDeletions = await validateSourceDeletions(
      workspacePath,
      codebase.graph,
      update.sourceDeletions,
      Object.keys(sources),
    );
    await validateCodebase(workspacePath, codebase, true, Object.keys(sources));
    const touchedFiles = [
      GRAPH_FILE,
      LAYOUT_FILE,
      ...Object.keys(sources),
      ...sourceDeletions,
      "AGENTS.md",
      "README.md",
      GRAPH_SCHEMA_FILE,
      LAYOUT_SCHEMA_FILE,
    ];
    const snapshot = await snapshotFiles(workspacePath, touchedFiles);
    try {
      for (const [relative, content] of Object.entries(sources)) {
        await writeTextAtomic(workspacePath, relative, content);
      }
      for (const relative of sourceDeletions) {
        await rm(await resolveWorkspaceMutationPath(workspacePath, relative), { force: true });
      }
      await writeJsonAtomic(workspacePath, GRAPH_FILE, codebase.graph);
      await writeJsonAtomic(workspacePath, LAYOUT_FILE, codebase.editorLayout);
      await ensureNodeCodebaseContract(workspacePath);
      await removeEmptySourceDirectories(workspacePath, sourceDeletions);
    } catch (cause) {
      await restoreFiles(workspacePath, snapshot);
      throw cause;
    }
  });
}

export async function ensureNodeCodebaseContract(
  workspacePath: string,
): Promise<void> {
  await Promise.all([
    ensureFile(path.join(workspacePath, "AGENTS.md"), AGENT_INSTRUCTIONS),
    ensureFile(path.join(workspacePath, "README.md"), PROJECT_DOCUMENTATION),
    writeJsonIfChanged(
      path.join(workspacePath, GRAPH_SCHEMA_FILE),
      PLAYABLE_GRAPH_SCHEMA,
    ),
    writeJsonIfChanged(
      path.join(workspacePath, LAYOUT_SCHEMA_FILE),
      EDITOR_LAYOUT_SCHEMA,
    ),
  ]);
}

async function validateCodebase(
  workspacePath: string,
  codebase: NodeCodebase,
  requireFiles: boolean,
  additionalFiles: string[] = [],
): Promise<void> {
  const availableFiles = requireFiles
    ? new Set(
        [
          ...(await listWorkspaceFiles(workspacePath))
          .filter((file) => !file.directory)
          .map((file) => file.path),
          ...additionalFiles,
        ],
      )
    : undefined;
  const validation = validateNodeGraph(codebase.graph, {
    mode: "draft",
    ...(availableFiles ? { availableFiles } : {}),
  });
  if (!validation.ok) {
    const first = validation.issues[0]!;
    throw new Error(`${first.path}: ${first.message}`);
  }
  if (!isNodeEditorLayout(codebase.editorLayout)) {
    throw new Error("Invalid editor/layout.json.");
  }
  if (!playableLayoutMatchesGraph(codebase.graph, codebase.editorLayout)) {
    throw new Error(
      "editor/layout.json Node IDs must exactly match graph.json Nodes.",
    );
  }
}

function blankCodebase(
  title: string,
  viewport: { width: number; height: number },
): NodeCodebase {
  return {
    graph: {
      version: 1,
      title,
      viewport,
      entryNodeId: "start",
      initialState: {},
      assets: {},
      nodes: [node("start", "Start", [])],
      edges: [],
    },
    editorLayout: layout({ start: { x: 120, y: 180 } }),
  };
}

function nightTrainCodebase(
  title: string,
  viewport: { width: number; height: number },
): NodeCodebase {
  return {
    graph: {
      version: 1,
      title,
      viewport,
      entryNodeId: "platform",
      initialState: { boarded: false },
      assets: {},
      shell: {
        source: {
          html: "shell/index.html",
          css: "shell/style.css",
          javascript: "shell/shell.js",
        },
        assets: [],
        signals: [{ id: "home", label: "Home" }],
      },
      nodes: [
        node("platform", "Platform", [
          { id: "board", label: "Board the train" },
        ]),
        node("carriage", "Carriage", [
          { id: "continue", label: "Continue" },
        ]),
        node("home", "Last train home", []),
      ],
      edges: [
        {
          id: "board-train",
          source: { nodeId: "platform", signal: "board" },
          targetNodeId: "carriage",
          mode: "replace",
        },
        {
          id: "reach-home",
          source: { nodeId: "carriage", signal: "continue" },
          targetNodeId: "home",
          mode: "replace",
        },
        {
          id: "shell-home",
          source: { nodeId: "shell", signal: "home" },
          targetNodeId: "platform",
          mode: "replace",
        },
      ],
    },
    editorLayout: layout({
      shell: { x: 80, y: -160 },
      platform: { x: 80, y: 180 },
      carriage: { x: 420, y: 180 },
      home: { x: 760, y: 180 },
    }),
  };
}

function node(
  id: string,
  title: string,
  signals: Array<{ id: string; label: string }>,
) {
  return {
    id,
    title,
    source: {
      html: `nodes/${id}/index.html`,
      css: `nodes/${id}/style.css`,
      javascript: `nodes/${id}/node.js`,
    },
    assets: [],
    signals,
  };
}

function layout(
  nodes: Record<string, { x: number; y: number }>,
): NodeEditorLayout {
  return {
    version: 1,
    nodes,
    viewport: { x: 0, y: 0, zoom: 1 },
    view: "canvas",
  };
}

function starterSources(graph: NodeGraph): Record<string, string> {
  const sources: Record<string, string> = { ...PLAYABLE_PROJECT_STYLE_FILES };
  for (const item of graph.nodes) {
    sources[item.source.html] = nodeHtml(item.id, item.title);
    sources[item.source.css] = NODE_CSS;
    sources[item.source.javascript] = nodeJavascript(item.id);
  }
  if (graph.shell) {
    sources[graph.shell.source.html] = '<nav><button type="button" data-home>Home</button></nav>\n';
    sources[graph.shell.source.css] = SHELL_CSS;
    sources[graph.shell.source.javascript] = SHELL_JAVASCRIPT;
  }
  return sources;
}

function nodeHtml(id: string, title: string): string {
  const escapedTitle = escapeHtml(title);
  if (id === "platform") {
    return `<main><p class="eyebrow">Platform 13</p><h1>${escapedTitle}</h1><p>The last train waits beneath the station lights.</p><button type="button" data-signal="board">Board the train</button></main>\n`;
  }
  if (id === "carriage") {
    return `<main><p class="eyebrow">01:17</p><h1>${escapedTitle}</h1><p>The empty carriage begins to move.</p><button type="button" data-signal="continue">Continue</button></main>\n`;
  }
  if (id === "home") {
    return `<main><p class="eyebrow">Dawn</p><h1>${escapedTitle}</h1><p>You step onto a familiar platform.</p></main>\n`;
  }
  return `<main><h1>${escapedTitle}</h1><p>Edit this Node's source to create the experience.</p></main>\n`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function nodeJavascript(id: string): string {
  if (id === "platform") {
    return `export function mount(context) {
  const button = context.root.querySelector('[data-signal="board"]');
  const board = async () => {
    await context.state.set("boarded", true);
    await context.navigation.emit("board");
  };
  button.addEventListener("click", board);
  return () => button.removeEventListener("click", board);
}
`;
  }
  const signal = id === "carriage" ? "continue" : undefined;
  if (signal) {
    return `export function mount(context) {
  const button = context.root.querySelector('[data-signal="${signal}"]');
  const proceed = () => context.navigation.emit("${signal}");
  button.addEventListener("click", proceed);
  return () => button.removeEventListener("click", proceed);
}
`;
  }
  return "export function mount() {}\n";
}

const NODE_CSS = `@import "../../shared/style/components.css";

:host { display: block; width: 100%; height: 100%; }
main { box-sizing: border-box; display: grid; width: 100%; height: 100%; place-content: center; justify-items: start; gap: 16px; padding: 8%; color: #f7f3e8; background: #171a1f; font-family: system-ui, sans-serif; }
h1, p { margin: 0; }
h1 { font-size: 48px; font-weight: 600; }
p { max-width: 560px; color: #c7c8c9; font-size: 18px; line-height: 1.6; }
.eyebrow { color: #d9b36c; font-size: 13px; text-transform: uppercase; }
button { border: 1px solid #d9b36c; padding: 12px 18px; color: #171a1f; background: #d9b36c; font: inherit; cursor: pointer; }
`;

const SHELL_CSS = `:host { display: block; width: 100%; height: 100%; pointer-events: none; }
nav { position: absolute; top: 20px; left: 20px; pointer-events: auto; }
button { border: 1px solid #ffffff40; padding: 8px 12px; color: white; background: #111827cc; font: 14px system-ui, sans-serif; cursor: pointer; }
`;

const SHELL_JAVASCRIPT = `export function mount(context) {
  const button = context.root.querySelector("[data-home]");
  const home = () => context.navigation.emit("home");
  button.addEventListener("click", home);
  return () => button.removeEventListener("click", home);
}
`;

async function readJson(file: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw cause;
  }
}

async function existingGeneratedFiles(
  workspacePath: string,
  files: string[],
): Promise<string[]> {
  const available = new Set(
    (await listWorkspaceFiles(workspacePath))
      .filter((file) => !file.directory)
      .map((file) => file.path),
  );
  return files.filter((file) => available.has(file));
}

async function ensureFile(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

async function writeJsonIfChanged(file: string, value: unknown): Promise<void> {
  const expected = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    if (await readFile(file, "utf8") === expected) return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await writeFile(file, expected, "utf8");
}

async function writeJson(
  file: string,
  value: unknown,
  flag?: "wx",
): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(flag ? { flag } : {}),
  });
}

async function writeJsonAtomic(
  workspacePath: string,
  relative: string,
  value: unknown,
): Promise<void> {
  const destination = await resolveWorkspaceMutationPath(workspacePath, relative);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeJson(temporary, value);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeTextAtomic(
  workspacePath: string,
  relative: string,
  content: string,
): Promise<void> {
  const destination = await resolveWorkspaceMutationPath(workspacePath, relative);
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateSourceUpdates(
  graph: NodeGraph,
  value: NodeCodebaseUpdate["sources"],
): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Playable source updates must be an object.");
  }
  const declared = new Set<string>();
  for (const node of graph.nodes) {
    declared.add(node.source.html);
    declared.add(node.source.css);
    declared.add(node.source.javascript);
  }
  if (graph.shell) {
    declared.add(graph.shell.source.html);
    declared.add(graph.shell.source.css);
    declared.add(graph.shell.source.javascript);
  }
  for (const [relative, content] of Object.entries(value)) {
    if (!declared.has(relative)) {
      throw new Error(`Source update "${relative}" is not declared by a Node or Shell.`);
    }
    if (typeof content !== "string") {
      throw new Error(`Source update "${relative}" must be text.`);
    }
  }
  return value;
}

async function validateSourceDeletions(
  workspacePath: string,
  nextGraph: NodeGraph,
  value: NodeCodebaseUpdate["sourceDeletions"],
  updatedSources: string[],
): Promise<string[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((relative) => typeof relative !== "string")) {
    throw new Error("Playable source deletions must be an array of paths.");
  }
  const deletions = [...new Set(value)];
  if (deletions.length !== value.length) {
    throw new Error("Playable source deletions must not contain duplicates.");
  }
  const currentValue = await readJson(path.join(workspacePath, GRAPH_FILE), GRAPH_FILE);
  const currentValidation = validateNodeGraph(currentValue);
  if (!currentValidation.ok) {
    throw new Error("The current graph.json is invalid and its sources cannot be deleted safely.");
  }
  const currentSources = declaredSourcePaths(currentValue as NodeGraph);
  const nextSources = declaredSourcePaths(nextGraph);
  const updates = new Set(updatedSources);
  for (const relative of deletions) {
    if (!currentSources.has(relative)) {
      throw new Error(`Source deletion "${relative}" is not declared by the current Node or Shell graph.`);
    }
    if (nextSources.has(relative)) {
      throw new Error(`Source deletion "${relative}" is still declared by a Node or Shell.`);
    }
    if (updates.has(relative)) {
      throw new Error(`Source "${relative}" cannot be updated and deleted together.`);
    }
  }
  return deletions;
}

function declaredSourcePaths(graph: NodeGraph): Set<string> {
  const declared = new Set<string>();
  for (const node of graph.nodes) {
    for (const kind of ["html", "css", "javascript"] as const) declared.add(node.source[kind]);
  }
  if (graph.shell) {
    for (const kind of ["html", "css", "javascript"] as const) declared.add(graph.shell.source[kind]);
  }
  return declared;
}

type FileSnapshot = Map<string, Buffer | undefined>;

async function snapshotFiles(
  workspacePath: string,
  files: string[],
): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  for (const relative of new Set(files)) {
    const file = await resolveWorkspaceMutationPath(workspacePath, relative);
    try {
      snapshot.set(relative, await readFile(file));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      snapshot.set(relative, undefined);
    }
  }
  return snapshot;
}

async function restoreFiles(
  workspacePath: string,
  snapshot: FileSnapshot,
): Promise<void> {
  for (const [relative, content] of snapshot) {
    const file = await resolveWorkspaceMutationPath(workspacePath, relative);
    if (content === undefined) {
      await rm(file, { force: true });
      continue;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function removeEmptySourceDirectories(
  workspacePath: string,
  deletedSources: string[],
): Promise<void> {
  const directories = [...new Set(deletedSources.map((relative) => path.posix.dirname(relative)))]
    .filter((relative) => relative !== ".")
    .sort((left, right) => right.length - left.length);
  for (const relative of directories) {
    try {
      await rmdir(await resolveWorkspaceMutationPath(workspacePath, relative));
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw cause;
    }
  }
}

async function resolveWorkspaceMutationPath(
  workspacePath: string,
  relative: string,
): Promise<string> {
  const normalized = relative.replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new NodeCodebaseError(`Invalid workspace path "${relative}".`);
  }
  const root = await realpath(workspacePath);
  const candidate = path.resolve(root, ...normalized.split("/"));
  assertInsideWorkspace(root, candidate, relative);

  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new NodeCodebaseError(`Workspace path "${relative}" cannot be a symbolic link.`);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }

  let existingParent = path.dirname(candidate);
  while (true) {
    try {
      const resolvedParent = await realpath(existingParent);
      assertInsideWorkspace(root, resolvedParent, relative);
      return candidate;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const parent = path.dirname(existingParent);
      if (parent === existingParent) throw cause;
      existingParent = parent;
    }
  }
}

function assertInsideWorkspace(root: string, candidate: string, relative: string): void {
  const relation = path.relative(root, candidate);
  if (relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new NodeCodebaseError(`Workspace path "${relative}" leaves the project workspace.`);
  }
}

async function withCodebaseLock<T>(
  workspacePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(workspacePath);
  const previous = codebaseOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => gate);
  codebaseOperations.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (codebaseOperations.get(key) === queued) codebaseOperations.delete(key);
  }
}
