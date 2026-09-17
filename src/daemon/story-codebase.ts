import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoryDocument, StoryEditorLayout, StorySurfaceFiles, StoryNode, StoryNodePresentation, StorySourceFiles } from "../shared/contracts.js";
import { parseStoryDocument, storyNodePresentation } from "../shared/story.js";

const STORY_FILE = "story.json";
const PROJECT_FILE = "project.json";
const EDITOR_LAYOUT_FILE = "editor-layout.json";
const EDITOR_PRESENTATION_FILE = "editor/presentation.js";
const EDITOR_STYLE_FILE = "editor/style.css";
const EDITOR_DOCUMENTATION_FILE = "editor/README.md";
const AGENT_INSTRUCTIONS_FILE = "AGENTS.md";
const DEFAULT_EDITOR_PRESENTATION = `/**
 * Optional project-local editor presentation.
 *
 * Return { replace: true } after rendering into root to replace OpenGame's
 * default node card or Inspector body. Return false to keep the default UI.
 * This module runs in a sandbox and cannot access the editor DOM or files.
 */
export const regions = [];

export function renderNode({ node, context, root }) {
  return false;
}

export function renderInspector({ node, context, root }) {
  return false;
}

export function renderPreview({ node, context, root }) {
  return false;
}

export function renderTimeline({ node, context, root }) {
  return false;
}

export function renderToolbar({ context, editor, root }) {
  return false;
}

export function renderWorkspace({ context, editor, root }) {
  return false;
}
`;
const DEFAULT_EDITOR_STYLE = `/* Styles in this file are scoped to sandboxed project editor surfaces. */
`;
const DEFAULT_EDITOR_DOCUMENTATION = `# Project Editor Extension

This directory customizes the Interactive Drama editor for this project using ordinary JavaScript and CSS.

## Presentation exports

\`presentation.js\` exports a \`regions\` array containing the enabled regions: \`workspace\`, \`toolbar\`, \`node\`, \`inspector\`, \`preview\`, and \`timeline\`. Only enabled regions create sandbox surfaces.
It may export the matching \`renderWorkspace\`, \`renderToolbar\`, \`renderNode\`, \`renderInspector\`, \`renderPreview\`, and \`renderTimeline\` functions.
Each function receives \`{ node, context, editor, root }\`. Render into \`root\` and return \`{ replace: true }\` to replace that default region. Return \`false\` to keep OpenGame's UI.

\`context\` contains the project, complete hydrated story, editor layout, current selection, and Variables. A node may use \`node.editor.kind\` and \`node.editor.properties\` for project-specific presentation while retaining its standard runtime \`node.type\`.

## Editor SDK

- \`editor.story()\` returns a cloned Story document.
- \`editor.transaction(change)\` applies one validated, undoable Story transaction.
- \`editor.replaceStory(story)\` validates and replaces the complete Story document.
- \`editor.updateNode\` and \`updatePlayer\` update Story nodes and Open UI.
- \`editor.createNode\`, \`deleteNode\`, \`connect\`, and \`disconnect\` are validated graph convenience operations.
- \`editor.setView(view)\` selects a built-in view.
- \`editor.setLayoutState(key, value)\` persists project-specific editor state in \`editor-layout.json\`.
- \`editor.openNode(nodeId)\`, \`closeNode()\`, and \`playtest()\` invoke stable platform navigation.
- \`editor.undo()\` and \`redo()\` operate on project-editor transactions.
- \`editor.useDefaultEditor()\` exits a custom full-workspace editor.

All changes cross the sandbox boundary and are validated by OpenGame. Extension code cannot access the host DOM, filesystem, or network. Missing exports, \`false\` returns, and runtime errors fall back to the default editor.
`;
const AGENT_INSTRUCTIONS = `# Interactive Drama Project

This workspace is the source of truth for an OpenGame Interactive Drama.

## Contract

- \`project.json\` identifies the workspace and its primary files.
- \`story.json\` contains the story graph, content, stable IDs, declared runtime behavior, and references to source files.
- \`editor-layout.json\` contains canvas positions, viewport, and the active workspace view. It has no game runtime meaning.
- \`editor/presentation.js\` optionally customizes node-card and Inspector content without replacing the editor shell.
- \`editor/style.css\` styles project editor surfaces inside their sandbox.
- Open UI nodes own their HTML, CSS, and JavaScript through \`data.presentation.surface.source\`.
- \`scenes/**\` contains the HTML, CSS, and JavaScript owned by individual Scenes.
- \`nodes/**\` contains the HTML, CSS, and JavaScript owned by Choice, Interaction, and Ending presentations.
- Every player-visible Story node owns \`data.presentation\`: a media strategy (\`own\`, \`inherit\`, or \`none\`) and a code surface. Interaction nodes additionally own declarative \`data.behavior\`.
- Source files referenced by \`story.json\` are authoritative. Do not inline a \`files\` object into Open UI or node presentations.
- Keep existing IDs and source paths stable when editing an object. Use new unique IDs for new objects.
- A Scene contains only \`title\` and \`presentation\`; its code surface owns any visual overlay UI.
- An Interaction contains only \`title\`, \`behavior\`, and \`presentation\`; connect its outcomes directly in Story Flow.
- Open UI is an ordinary Story node that owns its media, content, and code.
- \`node.editor.kind\` and optional \`node.editor.properties\` identify project-specific editor nodes while \`node.type\` retains stable runtime semantics.
- Keep \`story.json\` valid JSON and preserve \`codebase.version\`.

## Runtime interfaces

Open UI JavaScript exports \`render({ content, actions, root })\`. Call \`actions.run(action)\` for a declared action.

Scene, Choice, and Ending JavaScript export \`render({ node, scene, game, variables, actions, mode, root })\` and may export \`update(...)\`. They can emit semantic actions such as \`actions.choose(optionId)\`, \`actions.restart()\`, and \`actions.menu()\`; they cannot navigate to arbitrary node IDs.

Interaction JavaScript exports \`run({ game, ui, signal })\` and returns an outcome such as \`success\`, \`timeout\`, \`continue\`, or \`out\`. Declarative behavior applies variable actions and Story edges perform the transition.

Editor presentation JavaScript may export \`renderWorkspace\`, \`renderToolbar\`, \`renderNode\`, \`renderInspector\`, \`renderPreview\`, and \`renderTimeline\`. Return \`{ replace: true }\` to use the rendered content, or \`false\` to retain OpenGame's default UI. Use the provided \`editor\` SDK for validated project changes; the module runs in a sandbox without host DOM, filesystem, or network access.
`;
type UnknownRecord = Record<string, unknown>;

/**
 * Disk contract for Interactive Drama projects:
 * - story.json owns graph structure, content, metadata, and source references.
 * - ui/, scenes/, and nodes/ own executable HTML, CSS, and JavaScript.
 * The API hydrates these files into the StoryDocument runtime model.
 */
export async function readStoryCodebase(workspacePath: string): Promise<StoryDocument> {
  const raw: unknown = JSON.parse(await readFile(path.join(workspacePath, STORY_FILE), "utf8"));
  if (!isCanonicalStoryCodebase(raw)) throw new Error("Interactive Drama project uses an unsupported story format");
  const layout = await readEditorLayout(workspacePath);
  const hydrated = await hydrateSourceFiles(workspacePath, hydrateLayout(raw, layout));
  return parseStoryDocument(hydrated);
}

export async function writeStoryCodebase(workspacePath: string, story: StoryDocument, options: { preserveExistingSources?: boolean } = {}): Promise<void> {
  const normalized = withStableSources(story);
  const previousSources = await persistedSourcePaths(workspacePath);
  const preserve = options.preserveExistingSources ?? false;
  await Promise.all([
    ...normalized.chapters.flatMap((chapter) => chapter.nodes.flatMap((node) => isPresentationNode(node) && node.data.presentation?.surface.source
      ? [writeSourceFiles(workspacePath, node.data.presentation.surface.source, node.data.presentation.surface.files, preserve)]
      : [])),
  ]);
  const layout = editorLayoutFromStory(normalized);
  await Promise.all([
    writeJsonAtomic(workspacePath, PROJECT_FILE, { version: 1, type: "interactive-drama", story: STORY_FILE, editorLayout: EDITOR_LAYOUT_FILE, editorPresentation: EDITOR_PRESENTATION_FILE, editorStyle: EDITOR_STYLE_FILE, editorDocs: EDITOR_DOCUMENTATION_FILE }),
    writeJsonAtomic(workspacePath, STORY_FILE, dehydrateStory(normalized)),
    writeJsonAtomic(workspacePath, EDITOR_LAYOUT_FILE, layout),
  ]);
  const currentSources = sourcePaths(dehydrateStory(normalized));
  const removedSources = [...previousSources].filter((source) => !currentSources.has(source) && isManagedStorySource(source));
  await Promise.all(removedSources.map((source) => rm(resolveWorkspaceSource(workspacePath, source), { force: true })));
  await pruneManagedSourceDirectories(workspacePath, removedSources);
  await ensureStoryCodebaseInstructions(workspacePath);
}

export async function ensureStoryCodebaseInstructions(workspacePath: string): Promise<void> {
  await Promise.all([ensureEditorPresentation(workspacePath), ensureEditorStyle(workspacePath), ensureEditorDocumentation(workspacePath), ensureProjectManifest(workspacePath)]);
  try {
    await writeFile(path.join(workspacePath, AGENT_INSTRUCTIONS_FILE), AGENT_INSTRUCTIONS, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

async function ensureProjectManifest(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, PROJECT_FILE);
  try {
    const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (!isRecord(parsed)) throw new Error(`Invalid ${PROJECT_FILE}`);
    if (parsed.version === 1 && parsed.type === "interactive-drama" && parsed.story === STORY_FILE &&
      parsed.editorLayout === EDITOR_LAYOUT_FILE && parsed.editorPresentation === EDITOR_PRESENTATION_FILE && parsed.editorStyle === EDITOR_STYLE_FILE && parsed.editorDocs === EDITOR_DOCUMENTATION_FILE) return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await writeJsonAtomic(workspacePath, PROJECT_FILE, {
    version: 1,
    type: "interactive-drama",
    story: STORY_FILE,
    editorLayout: EDITOR_LAYOUT_FILE,
    editorPresentation: EDITOR_PRESENTATION_FILE,
    editorStyle: EDITOR_STYLE_FILE,
    editorDocs: EDITOR_DOCUMENTATION_FILE,
  });
}

async function ensureEditorDocumentation(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, EDITOR_DOCUMENTATION_FILE);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, DEFAULT_EDITOR_DOCUMENTATION, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

async function ensureEditorStyle(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, EDITOR_STYLE_FILE);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, DEFAULT_EDITOR_STYLE, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

async function ensureEditorPresentation(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, EDITOR_PRESENTATION_FILE);
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await writeFile(destination, DEFAULT_EDITOR_PRESENTATION, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

export function isCanonicalStoryCodebase(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 10 || !isRecord(value.codebase) || value.codebase.version !== 2) return false;
  if (records(value.chapters).some((chapter) => records(chapter.nodes).some((node) => isRecord(node.position)))) return false;
  if (["characters", "overlays", "interactions", "playerViews", "screens"].some((key) => key in value)) return false;
  if (!isRecord(value.player)) return false;
  if (!isRecord(value.player.viewport) || !Number.isInteger(value.player.viewport.width) || !Number.isInteger(value.player.viewport.height)) return false;
  return !records(value.chapters).some((chapter) => records(chapter.nodes).some((node) => {
    if (!["open-ui", "scene", "interaction", "choice", "ending"].includes(String(node.type))) return false;
    const data = node.data;
    if (!isRecord(data) || !isRecord(data.presentation) || !isRecord(data.presentation.surface)) return true;
    if (!isSourceReference(data.presentation.surface.source) || isRecord(data.presentation.surface.files)) return true;
    if (node.type === "scene") return !isRecord(data.presentation.media) ||
      (data.presentation.media.mode === "own" && !Array.isArray(data.presentation.media.items)) ||
      ["clips", "events", "media", "surface", "overlayIds"].some((key) => key in data);
    return node.type === "interaction" && (!isRecord(data.behavior) || "event" in data || "interactionId" in data);
  }));
}

function withStableSources(story: StoryDocument): StoryDocument {
  return {
    ...story,
    codebase: { version: 2 },
    chapters: story.chapters.map((chapter) => ({
      ...chapter,
      nodes: chapter.nodes.map((node) => withNodePresentationSource(chapter.id, node)),
    })),
  };
}

function isPresentationNode(node: StoryNode): node is Extract<StoryNode, { type: "open-ui" | "scene" | "interaction" | "choice" | "ending" }> {
  return node.type === "open-ui" || node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

function withNodePresentationSource(chapterId: string, node: StoryNode): StoryNode {
  if (!isPresentationNode(node)) return node;
  const current = storyNodePresentation(node);
  const presentation: StoryNodePresentation = {
    ...current,
    surface: {
      ...current.surface,
      source: validSource(current.surface.source) ?? sourceFor(node.type === "scene" ? "scene" : node.type === "open-ui" ? "open-ui" : "presentation", `${chapterId}:${node.type}:${node.id}`),
    },
  };
  if (node.type === "scene") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "open-ui") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "interaction") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "choice") return { ...node, data: { ...node.data, presentation } };
  return { ...node, data: { ...node.data, presentation } };
}

function dehydrateStory(story: StoryDocument): unknown {
  const value = structuredClone(story) as unknown as UnknownRecord;
  delete value.editorLayout;
  value.chapters = records(value.chapters).map((chapter) => ({
    ...chapter,
    nodes: records(chapter.nodes).map(({ position: _position, ...node }) => {
      if (!isRecord(node.data)) return node;
      const presentation = isRecord(node.data.presentation) && isRecord(node.data.presentation.surface)
        ? {
            ...node.data.presentation,
            surface: (({ files: _files, ...persisted }) => persisted)(node.data.presentation.surface),
          }
        : undefined;
      return { ...node, data: { ...node.data, ...(presentation ? { presentation } : {}) } };
    }),
  }));
  return value;
}

async function hydrateSourceFiles(workspacePath: string, input: unknown): Promise<unknown> {
  if (!isRecord(input)) return input;
  const value = structuredClone(input) as UnknownRecord;
  value.chapters = await Promise.all(records(value.chapters).map(async (chapter) => ({
    ...chapter,
    nodes: await Promise.all(records(chapter.nodes).map(async (node) => {
      if (!isRecord(node.data)) return node;
      const presentation = isRecord(node.data.presentation) && isRecord(node.data.presentation.surface) && isSourceReference(node.data.presentation.surface.source)
        ? { ...node.data.presentation, surface: { ...node.data.presentation.surface, files: await readSourceFiles(workspacePath, node.data.presentation.surface.source) } }
        : node.data.presentation;
      return { ...node, data: { ...node.data, ...(presentation ? { presentation } : {}) } };
    })),
  })));
  return value;
}

async function readEditorLayout(workspacePath: string): Promise<StoryEditorLayout> {
  const parsed: unknown = JSON.parse(await readFile(path.join(workspacePath, EDITOR_LAYOUT_FILE), "utf8"));
  if (!isEditorLayout(parsed)) throw new Error(`Invalid ${EDITOR_LAYOUT_FILE}`);
  return parsed;
}

function hydrateLayout(input: unknown, layout: StoryEditorLayout): unknown {
  if (!isRecord(input)) return input;
  const expectedIds = new Set(records(input.chapters).flatMap((chapter) => records(chapter.nodes).flatMap((node) => typeof node.id === "string" ? [node.id] : [])));
  const layoutIds = Object.keys(layout.nodes);
  if (layoutIds.length !== expectedIds.size || layoutIds.some((id) => !expectedIds.has(id))) {
    throw new Error(`Invalid ${EDITOR_LAYOUT_FILE}: node positions do not match story.json`);
  }
  return {
    ...input,
    codebase: { version: 2 },
    editorLayout: layout,
    chapters: records(input.chapters).map((chapter) => ({
      ...chapter,
      nodes: records(chapter.nodes).map((node) => ({
        ...node,
        position: typeof node.id === "string" ? layout.nodes[node.id] : undefined,
      })),
    })),
  };
}

function editorLayoutFromStory(story: StoryDocument): StoryEditorLayout {
  const prior = story.editorLayout;
  const currentIds = new Set(story.chapters.flatMap((chapter) => chapter.nodes.map((node) => node.id)));
  const nodes = Object.fromEntries(Object.entries(prior.nodes).filter(([id]) => currentIds.has(id)));
  for (const chapter of story.chapters) for (const node of chapter.nodes) nodes[node.id] = node.position;
  return {
    version: 1,
    nodes,
    viewport: prior.viewport,
    view: prior.view,
    ...(prior.extensions ? { extensions: prior.extensions } : {}),
  };
}

function isEditorLayout(value: unknown): value is StoryEditorLayout {
  return isRecord(value) && value.version === 1 && isRecord(value.nodes) && Object.values(value.nodes).every(isPosition) &&
    isViewport(value.viewport) &&
    (value.view === "canvas" || value.view === "code") &&
    (value.extensions === undefined || isRecord(value.extensions));
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}

function isViewport(value: unknown): value is { x: number; y: number; zoom: number } {
  return isPosition(value) && "zoom" in value && typeof value.zoom === "number" && Number.isFinite(value.zoom) && value.zoom > 0;
}

async function readSourceFiles(workspacePath: string, source: StorySourceFiles): Promise<StorySurfaceFiles> {
  const [html, css, javascript] = await Promise.all([
    readWorkspaceSource(workspacePath, source.html),
    readWorkspaceSource(workspacePath, source.css),
    readWorkspaceSource(workspacePath, source.javascript),
  ]);
  return { html, css, javascript };
}

async function writeSourceFiles(workspacePath: string, source: StorySourceFiles, files: StorySurfaceFiles, preserveExisting = false): Promise<void> {
  await Promise.all([
    writeWorkspaceSource(workspacePath, source.html, files.html, preserveExisting),
    writeWorkspaceSource(workspacePath, source.css, files.css, preserveExisting),
    writeWorkspaceSource(workspacePath, source.javascript, files.javascript, preserveExisting),
  ]);
}

async function readWorkspaceSource(workspacePath: string, relativePath: string): Promise<string> {
  return readFile(resolveWorkspaceSource(workspacePath, relativePath), "utf8");
}

async function writeWorkspaceSource(workspacePath: string, relativePath: string, content: string, preserveExisting = false): Promise<void> {
  const destination = resolveWorkspaceSource(workspacePath, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  if (preserveExisting) {
    try {
      await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    return;
  }
  const temporary = await atomicTemporary(workspacePath);
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function persistedSourcePaths(workspacePath: string): Promise<Set<string>> {
  try {
    return sourcePaths(JSON.parse(await readFile(path.join(workspacePath, STORY_FILE), "utf8")));
  } catch {
    return new Set();
  }
}

function sourcePaths(value: unknown): Set<string> {
  const paths = new Set<string>();
  if (!isRecord(value)) return paths;
  const add = (source: unknown) => {
    if (!isSourceReference(source)) return;
    paths.add(source.html); paths.add(source.css); paths.add(source.javascript);
  };
  for (const chapter of records(value.chapters)) for (const node of records(chapter.nodes)) {
    if (isRecord(node.data) && isRecord(node.data.presentation) && isRecord(node.data.presentation.surface)) add(node.data.presentation.surface.source);
  }
  return paths;
}

function isManagedStorySource(value: string): boolean {
  return ["scenes/", "nodes/", "ui/"].some((prefix) => value.startsWith(prefix));
}

async function pruneManagedSourceDirectories(workspacePath: string, sources: readonly string[]): Promise<void> {
  const directories = new Set(sources.map((source) => path.posix.dirname(source)).filter((directory) => directory.includes("/")));
  await Promise.all([...directories].map(async (directory) => {
    try {
      await rmdir(resolveWorkspaceSource(workspacePath, directory));
    } catch (cause) {
      if (!["ENOENT", "ENOTEMPTY"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
    }
  }));
}

function resolveWorkspaceSource(workspacePath: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!isWorkspacePath(normalized)) throw new Error(`Invalid story source path: ${relativePath}`);
  const destination = path.resolve(workspacePath, ...normalized.split("/"));
  const relative = path.relative(path.resolve(workspacePath), destination);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Story source leaves the workspace: ${relativePath}`);
  return destination;
}

function sourceFor(kind: "scene" | "open-ui" | "presentation", id: string): StorySourceFiles {
  const base = kind === "scene" ? `scenes/${sourceSegment(id)}` : kind === "open-ui" ? `ui/${sourceSegment(id)}` : `nodes/${sourceSegment(id)}`;
  return {
    html: `${base}/index.html`,
    css: `${base}/style.css`,
    javascript: `${base}/${kind === "scene" ? "scene.js" : kind === "open-ui" ? "screen.js" : "surface.js"}`,
  };
}

function sourceSegment(id: string): string {
  const readable = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "definition";
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${readable}-${(hash >>> 0).toString(36)}`;
}

function validSource(value: StorySourceFiles | undefined): StorySourceFiles | undefined {
  return value && isSourceReference(value) ? value : undefined;
}

function isSourceReference(value: unknown): value is StorySourceFiles {
  return isRecord(value) && typeof value.html === "string" && typeof value.css === "string" && typeof value.javascript === "string" &&
    [value.html, value.css, value.javascript].every(isWorkspacePath);
}

function isAssetReference(value: unknown): value is { type: "library"; assetId: string } | { type: "node"; nodeId: string } {
  return isRecord(value) && (value.type === "library" ? nonEmptyString(value.assetId) : value.type === "node" && nonEmptyString(value.nodeId));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isWorkspacePath(value: string): boolean {
  return Boolean(value) && !value.startsWith("/") && !value.split("/").some((part) => !part || part === "." || part === "..");
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(workspacePath: string, relativePath: string, value: unknown): Promise<void> {
  const destination = path.join(workspacePath, relativePath);
  const temporary = await atomicTemporary(workspacePath);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicTemporary(workspacePath: string): Promise<string> {
  const directory = path.join(workspacePath, ".data", "story-codebase-writes");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `${process.pid}.${randomUUID()}.tmp`);
}
