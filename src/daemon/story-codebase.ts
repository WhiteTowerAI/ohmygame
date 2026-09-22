import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { VIDEO_MODEL, type StoryDocument, type StoryEditorLayout, type StorySurfaceFiles, type StoryNode, type StoryNodePresentation, type StorySourceFiles } from "../shared/contracts.js";
import { EDITOR_LAYOUT_SCHEMA } from "../shared/editor-layout-schema.js";
import { defaultStoryNodeSource, parseStoryDocument, storyNodePresentation } from "../shared/story.js";
import { STORY_CODEBASE_SCHEMA } from "../shared/story-schema.js";

const STORY_FILE = "story.json";
const EDITOR_LAYOUT_FILE = "editor/layout.json";
const DOCUMENTATION_FILE = "README.md";
const STORY_SCHEMA_FILE = "schemas/story.schema.json";
const EDITOR_LAYOUT_SCHEMA_FILE = "schemas/editor-layout.schema.json";
const AGENT_INSTRUCTIONS_FILE = "AGENTS.md";
const DEFAULT_EDITOR_DOCUMENTATION = `# Interactive Drama Project Guide

## Story format

\`schemas/story.schema.json\` and \`schemas/editor-layout.schema.json\` are the machine-readable definitions of the persisted \`story.json\` and \`editor/layout.json\` formats. Read the corresponding schema before editing either file; field names and enum values are exact, and objects reject undocumented properties.

The schema checks the shape of one JSON document. OhMyGame additionally validates relationships that JSON Schema cannot fully express:

- node IDs are unique;
- edges reference nodes in the same chapter;
- Choice handles match option IDs;
- Condition handles are exactly \`"true"\` and \`"false"\`;
- the chapter has at most one Start node;
- IDs for nodes, edges, Choice options, and presentation media are unique in their scope;
- Choice timeouts reference an option in the same Choice;
- Interaction timeouts reference an outcome in the same Interaction;
- actions and conditions reference compatible declared Variables;
- Interaction outcomes are unique within each node and match its outgoing edge handles;
- \`editor/layout.json\` contains exactly one position for every Story node;
- referenced source files exist and stay inside the workspace.

Presentation source objects use the exact keys \`html\`, \`css\`, and \`javascript\`. Presentation media uses an \`items\` array; an empty array means no media. A Start node has an empty \`data\` object.

A Scene with no media or any image requires \`data.durationMs\` from 1000 to 300000 milliseconds. It controls how long each image or an empty Scene remains visible. A Scene containing only videos must omit \`durationMs\`; videos advance when playback actually ends.

Choice and Update State actions use \`type: "update-variable"\` with an \`operator\` of \`"set"\`, \`"add"\`, \`"subtract"\`, \`"multiply"\`, or \`"divide"\`. Only \`"set"\` supports Text and Boolean Variables; arithmetic operators require a Number Variable and numeric \`value\`.

A Condition node reads one declared Variable and immediately follows its \`"true"\` or \`"false"\` edge. Number conditions support equality plus \`"greater-than"\`, \`"greater-than-or-equal"\`, \`"less-than"\`, and \`"less-than-or-equal"\`; Text and Boolean conditions support equality only.

The editor layout \`view\` is either \`"canvas"\` or \`"code"\`. Preserve the existing view and viewport unless the user explicitly asks to change them.

## Runtime surfaces

Each chapter has exactly one Open UI node directly after Start and one Story Map node connected from Open UI's \`"story-map"\` output. Story Map is a system screen, not a story step. Use Scene or Interaction for in-story interfaces. Open UI JavaScript exports \`render({ content, actions, root })\`. Its \`content.buttons\` entries use the semantic actions \`"start-game"\`, \`"continue-game"\`, \`"new-game"\`, and \`"open-story-map"\`; call \`actions.run(button.action)\`. The Player shows these buttons only when their state is relevant.

Story Map JavaScript exports \`render({ content, actions, root })\`. The runtime supplies read-only derived map nodes, edges, discovery state, and counts through \`content\`; call \`actions.run("close")\` to return without changing story state.

Open UI HTML may mark movable elements with a unique \`data-layout-id\`. Its optional \`presentation.surface.layout\` object stores logical-pixel \`offsetX\` and \`offsetY\` values by that ID; the player applies those offsets without replacing the element's authored CSS layout.

Scene, Choice, and Ending JavaScript exports \`render({ node, scene, variables, actions, mode, root })\` and may export \`update(...)\`. The runtime \`node\` view contains \`id\`, \`type\`, and \`title\`, plus type-specific values such as Choice \`options\` or Ending \`description\`. Choices call \`actions.choose(option.id)\`; endings may call \`actions.restart()\` and \`actions.menu()\`.

Interaction JavaScript exports \`run({ game, ui, signal })\` and returns one of the strings declared in that node's \`data.outcomes\`. The code fully owns the interaction behavior; names such as Hotspot, QTE, and Continue describe starter templates, not runtime types. Optional \`data.timeout\` defines the overall pause-aware deadline and the outcome returned when it expires; the runtime owns this deadline and cancels unfinished code. On timeout, buffered Variable commands are discarded and any later code result is ignored.

\`ui\` provides \`root\`, \`querySelector(selector)\`, \`waitForClick(target)\`, \`waitForKey(code)\`, and \`waitForTimeout(duration)\`. Use \`ui.waitForTimeout\` for delays inside behavior, not for the node's overall deadline. These wait helpers pause and resume with the Player; raw browser timers do not. \`game.variables.get(idOrName)\`, \`set(idOrName, value)\`, and \`increment(idOrName, amount)\` read or update declared Variables. Use \`signal\` to cancel additional asynchronous work when the node stops.
`;
const BASE_AGENT_INSTRUCTIONS = `# Interactive Drama Project

This workspace is the source of truth for an OhMyGame Interactive Drama.

## Contract

- \`story.json\` contains the story graph, content, stable IDs, declared Interaction outcomes, and references to source files.
- \`editor/layout.json\` contains canvas positions, viewport, and the active workspace view. It has no game runtime meaning.
- \`schemas/story.schema.json\` defines the exact persisted \`story.json\` structure. Read it before editing Story data; do not guess field names.
- \`schemas/editor-layout.schema.json\` defines the exact persisted \`editor/layout.json\` structure. Its \`view\` is \`"canvas"\` or \`"code"\`.
- \`README.md\` explains graph semantics and runtime surface APIs.
- Every presentation node owns HTML, CSS, and JavaScript through \`data.presentation.surface.source\`; new nodes default to \`nodes/<derived-node-id>/\`.
- Every player-visible Story node owns \`data.presentation\`: a media \`items\` array and a code surface. Interaction nodes additionally declare the graph ports in \`data.outcomes\`.
- The player shows its shared pause button on Scene, Interaction, and Choice nodes.
- \`variables[].initialValue\` is the only source of new-game state. Use an Update State node only for changes that happen while the story is running.
- Use a Condition node for automatic variable-based branching; its outgoing edges use \`"true"\` and \`"false"\` as \`sourceHandle\`.
- Source files referenced by \`story.json\` are authoritative. Do not inline a \`files\` object into Open UI or node presentations.
- Keep existing IDs and source paths stable when editing an object. Use new unique IDs for new objects.
- A Scene contains \`title\` and \`presentation\`; its code surface owns any visual overlay UI. Add \`durationMs\` for an empty Scene or one containing images, and omit it when every media item is a video. Images use \`durationMs\`; videos advance when playback actually ends.
- An Interaction contains \`title\`, \`outcomes\`, optional \`timeout\`, and \`presentation\`. Its JavaScript owns all behavior and must return one declared outcome; connect every outcome directly in Story Flow. The runtime owns the optional overall timeout.
- Open UI is an ordinary Story node that owns its media, content, and code.
- An Open UI element is visually movable only when its HTML declares a unique \`data-layout-id\`; optional offsets live in \`presentation.surface.layout\` and affect the final runtime.
- Keep \`story.json\` valid JSON and preserve its \`version\`.

Use \`README.md\` as the source of truth for runtime JavaScript interfaces.
`;
const WORKING_BOUNDARY_INSTRUCTIONS = `## Working boundary

Work only inside the current project workspace. Use relative workspace paths.
Do not use absolute paths or paths containing \`..\`.

Do not inspect parent directories, other projects, user directories, package installations, the OhMyGame source repository, or OhMyGame tests. Do not search outside this workspace for examples, schemas, validators, or runtime implementation details.

Treat this file, \`README.md\`, both files in \`schemas/\`, \`story.json\`, \`editor/layout.json\`, and the current node source files as the complete project contract. If a capability is not documented here, use the smallest structure already present in this project instead of reverse-engineering the OhMyGame application.

An exception applies only when the user explicitly provides an external file path and asks to import that file: read only that exact file and copy it into this workspace. Do not inspect its parent directory.

`;
const FAST_PATH_INSTRUCTIONS = `## Fast path for simple canvas edits

For a request that only creates, updates, moves, or deletes standard Story nodes:

1. Read only the contract files relevant to the change:
   - moving nodes or changing the canvas view: \`schemas/editor-layout.schema.json\` and \`editor/layout.json\`;
   - creating, updating, deleting, or connecting nodes: both schema files, \`story.json\`, and \`editor/layout.json\`;
   - changing player-facing HTML, CSS, or JavaScript: also read \`README.md\` and that node's source files.
2. Do not inspect Git, the OhMyGame application source, Godot, MCP servers, or unrelated files.
3. Make the smallest possible edits and preserve every unrelated field.
4. Keep node IDs unique and stable. Every node ID in \`story.json\` must have exactly one position in \`editor/layout.json\`, and the layout must not contain extra node IDs.
5. Parse each changed JSON file, then check every changed object against the relevant schema's \`required\`, \`additionalProperties\`, type, and enum constraints. Parsing alone checks syntax, not the schema. Check the cross-file rules below once, then stop. Do not search for or install a schema validator, and do not run a development server or build for a simple canvas edit.

Canvas node positions live only in \`editor/layout.json\`; never add \`position\` to a persisted \`story.json\` node. Place a new node near the visible group of existing nodes, or at \`{ "x": 80, "y": 180 }\` when the canvas is empty.

### Empty generation nodes

Use the project Player viewport ratio when it is supported: \`1280 x 720\` uses \`16:9\`, \`720 x 1280\` uses \`9:16\`, and \`1080 x 1080\` uses \`1:1\`. The minimal persisted Image node is:

\`\`\`json
{
  "id": "image-<unique-id>",
  "type": "image",
  "data": {
    "prompt": "",
    "resolution": "1K",
    "aspectRatio": "16:9",
    "images": []
  }
}
\`\`\`

The minimal persisted Video node is:

\`\`\`json
{
  "id": "video-<unique-id>",
  "type": "video",
  "data": {
    "prompt": "",
    "model": "${VIDEO_MODEL}",
    "resolution": "720p",
    "aspectRatio": "16:9",
    "duration": 6,
    "references": []
  }
}
\`\`\`

Do not generate media when the user asks for an empty generation node.

`;
const BASIC_TEMPLATE_INSTRUCTIONS = `## Basic template path

When the user asks for a basic Interactive Drama template without specifying its structure, create a compact playable story that demonstrates the standard Story capabilities:

\`start -> open-ui -> scene -> choice -> update-state -> scene -> interaction -> ending-a / ending-b\`

Declare at least one Variable with its new-game \`initialValue\` and use it through an Update State action, Choice action or condition, or Interaction code. Include one Start, one Open UI, at least two Scenes, one Choice with two branches, one Interaction, and two Endings. Add an Update State node only when the story needs a state change at that point in the flow. Keep the graph compact; do not add nodes merely to demonstrate every available feature. Preserve existing Image, Video, and other asset nodes without changing their configuration, and do not generate media unless requested.

For a Choice, each option has a stable \`id\` and the matching outgoing edge uses that option ID as \`sourceHandle\`. For all other standard flow edges, use the node's default outgoing handle. Every edge source and target must reference a node in the same chapter.

Follow \`schemas/story.schema.json\` exactly for every node. Each presentation source uses the keys \`html\`, \`css\`, and \`javascript\`. Follow \`README.md\` for JavaScript exports and action APIs.

Keep the visual implementation minimal. Do not create a design system or elaborate custom editor presentation for a basic template.

After writing a template, perform one local check of the changed objects against both schemas, then check unique node IDs, exact story/layout ID correspondence, valid edge endpoints, and existence of referenced source files. Do not search for or install a schema validator, invoke an OhMyGame source parser, search the application repository, run a development server, or claim that the story was playtested unless you actually opened the Player and completed the flow.
`;
const AGENT_INSTRUCTIONS = `${BASE_AGENT_INSTRUCTIONS}\n${WORKING_BOUNDARY_INSTRUCTIONS}${FAST_PATH_INSTRUCTIONS}${BASIC_TEMPLATE_INSTRUCTIONS}`;
type UnknownRecord = Record<string, unknown>;

/**
 * Disk contract for Interactive Drama projects:
 * - story.json owns graph structure, content, metadata, and source references.
 * - nodes/ is the default location for executable HTML, CSS, and JavaScript owned by presentation nodes.
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
  await Promise.all(normalized.chapter.nodes.flatMap((node) => isPresentationNode(node) && node.data.presentation?.surface.source
    ? [writeSourceFiles(workspacePath, node.data.presentation.surface.source, node.data.presentation.surface.files, preserve)]
    : []));
  const layout = editorLayoutFromStory(normalized);
  await Promise.all([
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
  await Promise.all([ensureDocumentation(workspacePath), ensureStorySchema(workspacePath), ensureEditorLayoutSchema(workspacePath)]);
  const destination = path.join(workspacePath, AGENT_INSTRUCTIONS_FILE);
  try {
    const current = await readFile(destination, "utf8");
    if (current === AGENT_INSTRUCTIONS) return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    await writeFile(destination, AGENT_INSTRUCTIONS, { encoding: "utf8", flag: "wx" });
  }
}

async function ensureStorySchema(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, STORY_SCHEMA_FILE);
  const expected = `${JSON.stringify(STORY_CODEBASE_SCHEMA, null, 2)}\n`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    if (await readFile(destination, "utf8") === expected) return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await writeJsonAtomic(workspacePath, STORY_SCHEMA_FILE, STORY_CODEBASE_SCHEMA);
}

async function ensureEditorLayoutSchema(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, EDITOR_LAYOUT_SCHEMA_FILE);
  const expected = `${JSON.stringify(EDITOR_LAYOUT_SCHEMA, null, 2)}\n`;
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    if (await readFile(destination, "utf8") === expected) return;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  await writeJsonAtomic(workspacePath, EDITOR_LAYOUT_SCHEMA_FILE, EDITOR_LAYOUT_SCHEMA);
}

async function ensureDocumentation(workspacePath: string): Promise<void> {
  const destination = path.join(workspacePath, DOCUMENTATION_FILE);
  try {
    await writeFile(destination, DEFAULT_EDITOR_DOCUMENTATION, { encoding: "utf8", flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
  }
}

export function isCanonicalStoryCodebase(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.chapter)) return false;
  if (records(value.chapter.nodes).some((node) => isRecord(node.position))) return false;
  if (["characters", "overlays", "interactions", "playerViews", "screens"].some((key) => key in value)) return false;
  if (!isRecord(value.player)) return false;
  if (!isRecord(value.player.viewport) || !Number.isInteger(value.player.viewport.width) || !Number.isInteger(value.player.viewport.height)) return false;
  return !records(value.chapter.nodes).some((node) => {
    if (!["open-ui", "story-map", "scene", "interaction", "choice", "ending"].includes(String(node.type))) return false;
    const data = node.data;
    if (!isRecord(data) || !isRecord(data.presentation) || !isRecord(data.presentation.surface)) return true;
    if (!isSourceReference(data.presentation.surface.source) || isRecord(data.presentation.surface.files)) return true;
    if (node.type === "scene") return !isRecord(data.presentation.media) || !Array.isArray(data.presentation.media.items) ||
      ["clips", "events", "media", "surface", "overlayIds"].some((key) => key in data);
    return node.type === "interaction" && (!Array.isArray(data.outcomes) || "event" in data || "interactionId" in data || "behavior" in data);
  });
}

function withStableSources(story: StoryDocument): StoryDocument {
  return {
    ...story,
    chapter: { ...story.chapter, nodes: story.chapter.nodes.map(withNodePresentationSource) },
  };
}

function isPresentationNode(node: StoryNode): node is Extract<StoryNode, { type: "open-ui" | "story-map" | "scene" | "interaction" | "choice" | "ending" }> {
  return node.type === "open-ui" || node.type === "story-map" || node.type === "scene" || node.type === "interaction" || node.type === "choice" || node.type === "ending";
}

function withNodePresentationSource(node: StoryNode): StoryNode {
  if (!isPresentationNode(node)) return node;
  const current = storyNodePresentation(node);
  const presentation: StoryNodePresentation = {
    ...current,
    surface: {
      ...current.surface,
      source: validSource(current.surface.source) ?? defaultStoryNodeSource(node.id),
    },
  };
  if (node.type === "scene") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "open-ui") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "story-map") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "interaction") return { ...node, data: { ...node.data, presentation } };
  if (node.type === "choice") return { ...node, data: { ...node.data, presentation } };
  return { ...node, data: { ...node.data, presentation } };
}

function dehydrateStory(story: StoryDocument): unknown {
  const value = structuredClone(story) as unknown as UnknownRecord;
  delete value.editorLayout;
  value.chapter = {
    ...record(value.chapter),
    nodes: records(record(value.chapter)?.nodes).map(({ position: _position, ...node }) => {
      if (!isRecord(node.data)) return node;
      const presentation = isRecord(node.data.presentation) && isRecord(node.data.presentation.surface)
        ? {
            ...node.data.presentation,
            surface: (({ files: _files, ...persisted }) => persisted)(node.data.presentation.surface),
          }
        : undefined;
      return { ...node, data: { ...node.data, ...(presentation ? { presentation } : {}) } };
    }),
  };
  return value;
}

async function hydrateSourceFiles(workspacePath: string, input: unknown): Promise<unknown> {
  if (!isRecord(input)) return input;
  const value = structuredClone(input) as UnknownRecord;
  const chapter = record(value.chapter);
  value.chapter = {
    ...chapter,
    nodes: await Promise.all(records(chapter?.nodes).map(async (node) => {
      if (!isRecord(node.data)) return node;
      const presentation = isRecord(node.data.presentation) && isRecord(node.data.presentation.surface) && isSourceReference(node.data.presentation.surface.source)
        ? { ...node.data.presentation, surface: { ...node.data.presentation.surface, files: await readSourceFiles(workspacePath, node.data.presentation.surface.source) } }
        : node.data.presentation;
      return { ...node, data: { ...node.data, ...(presentation ? { presentation } : {}) } };
    })),
  };
  return value;
}

async function readEditorLayout(workspacePath: string): Promise<StoryEditorLayout> {
  const parsed: unknown = JSON.parse(await readFile(path.join(workspacePath, EDITOR_LAYOUT_FILE), "utf8"));
  if (!isEditorLayout(parsed)) throw new Error(`Invalid ${EDITOR_LAYOUT_FILE}`);
  return parsed;
}

function hydrateLayout(input: unknown, layout: StoryEditorLayout): unknown {
  if (!isRecord(input)) return input;
  const chapter = record(input.chapter);
  const expectedIds = new Set(records(chapter?.nodes).flatMap((node) => typeof node.id === "string" ? [node.id] : []));
  const layoutIds = Object.keys(layout.nodes);
  if (layoutIds.length !== expectedIds.size || layoutIds.some((id) => !expectedIds.has(id))) {
    throw new Error(`Invalid ${EDITOR_LAYOUT_FILE}: node positions do not match story.json`);
  }
  return {
    ...input,
    editorLayout: layout,
    chapter: {
      ...chapter,
      nodes: records(chapter?.nodes).map((node) => ({
        ...node,
        position: typeof node.id === "string" ? layout.nodes[node.id] : undefined,
      })),
    },
  };
}

function editorLayoutFromStory(story: StoryDocument): StoryEditorLayout {
  const prior = story.editorLayout;
  const currentIds = new Set(story.chapter.nodes.map((node) => node.id));
  const nodes = Object.fromEntries(Object.entries(prior.nodes).filter(([id]) => currentIds.has(id)));
  for (const node of story.chapter.nodes) nodes[node.id] = node.position;
  return {
    version: 1,
    nodes,
    viewport: prior.viewport,
    view: prior.view,
  };
}

function isEditorLayout(value: unknown): value is StoryEditorLayout {
  return isRecord(value) && value.version === 1 && isRecord(value.nodes) && Object.values(value.nodes).every(isPosition) &&
    isViewport(value.viewport) &&
    (value.view === "canvas" || value.view === "code");
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
  for (const node of records(record(value.chapter)?.nodes)) {
    if (isRecord(node.data) && isRecord(node.data.presentation) && isRecord(node.data.presentation.surface)) add(node.data.presentation.surface.source);
  }
  return paths;
}

function isManagedStorySource(value: string): boolean {
  return value.startsWith("nodes/");
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

function record(value: unknown): UnknownRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeJsonAtomic(workspacePath: string, relativePath: string, value: unknown): Promise<void> {
  const destination = path.join(workspacePath, relativePath);
  const temporary = await atomicTemporary(workspacePath);
  try {
    await mkdir(path.dirname(destination), { recursive: true });
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
