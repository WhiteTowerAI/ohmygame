import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NodeGraph } from "../shared/playable-nodes.js";
import { AGENT_INSTRUCTIONS, PROJECT_DOCUMENTATION, PROJECT_GUIDE_UPGRADES, resolveWorkspaceMutationPath } from "./playable-codebase.js";
import { STORY_WEB_DIRECTORY, STORY_WEB_ENTRY, storyWebRuntimeModules } from "./story-web-bundle.js";

/**
 * A web story is an Interactive Story project that plays as its own page:
 * `index.html` loads the story runtime under `story/`, which reads
 * `graph.json` and plays the Scenes from their own files. This module makes
 * and keeps those files.
 */

/** Records which runtime OhMyGame wrote, and each file as it wrote it. */
export const STORY_WEB_MANIFEST = `${STORY_WEB_DIRECTORY}/manifest.json`;
/** Where a newer runtime waits for the files the author changed, in the editor cache. */
export const STORY_WEB_UPDATES = ".ohmygame/story-runtime";

export interface StoryWebManifest {
  version: string;
  /** SHA-256 of each runtime file as OhMyGame wrote it, by project path. */
  files: Record<string, string>;
  /**
   * Files the author changed that a newer runtime also changes. The newer
   * file is under `.ohmygame/story-runtime/<version>/` for the Agent to merge.
   */
  pending?: { version: string; files: string[] };
}

export interface StoryRuntimeInstall {
  /** Project paths written. */
  written: string[];
  /** Runtime files the author changed and a newer runtime changes too. */
  pending: string[];
}

export async function isWebStory(workspacePath: string): Promise<boolean> {
  return exists(path.join(workspacePath, ...STORY_WEB_ENTRY.split("/")));
}

/**
 * Brings the project's story runtime up to the one OhMyGame ships. A file the
 * author never changed is replaced; one they changed is kept, and the newer
 * file is left beside the project for the Agent to merge. Files the runtime
 * no longer has go if they were never changed.
 */
export async function installStoryRuntime(workspacePath: string): Promise<StoryRuntimeInstall> {
  const modules = await storyWebRuntimeModules();
  const version = runtimeVersion(modules);
  const manifest = await readManifest(workspacePath);
  if (manifest?.version === version && !manifest.pending) return { written: [], pending: [] };

  const files: Record<string, string> = {};
  const written: string[] = [];
  const pending: string[] = [];
  for (const [relative, content] of Object.entries(modules)) {
    const shipped = hash(content);
    const current = await readText(workspacePath, relative);
    const unchanged = current === undefined || hash(current) === manifest?.files[relative];
    if (current !== undefined && hash(current) === shipped) {
      files[relative] = shipped;
    } else if (unchanged) {
      await writeText(workspacePath, relative, content);
      files[relative] = shipped;
      written.push(relative);
    } else {
      // The author's change stays; the base it was made from stays recorded.
      files[relative] = manifest?.files[relative] ?? hash(current);
      pending.push(relative);
      const update = `${STORY_WEB_UPDATES}/${version}/${relative}`;
      if ((await readText(workspacePath, update)) !== content) await writeText(workspacePath, update, content);
    }
  }
  for (const [relative, recorded] of Object.entries(manifest?.files ?? {})) {
    if (relative in modules) continue;
    const current = await readText(workspacePath, relative);
    if (current !== undefined && hash(current) === recorded) {
      await rm(await resolveWorkspaceMutationPath(workspacePath, relative), { force: true });
      written.push(relative);
    }
  }
  const next: StoryWebManifest = {
    version,
    files,
    ...(pending.length ? { pending: { version, files: pending } } : {}),
  };
  await writeText(workspacePath, STORY_WEB_MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
  return { written: [...written, STORY_WEB_MANIFEST], pending };
}

/**
 * The page that plays the story. Its story ID names the player's saves, so
 * they last when the game is published somewhere new or updated where the
 * address changes with each upload, as on itch.io.
 */
export function storyWebIndexHtml(title: string, storyId: string = randomUUID()): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="ohmygame-story" content="${escapeHtml(storyId)}" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <script type="module" src="${STORY_WEB_ENTRY}"></script>
  </body>
</html>
`;
}

/** What plays a web story besides its assets; everything else is the editor's. */
const PLAYED_FILES = ["index.html", "graph.json"];
const PLAYED_DIRECTORIES = [STORY_WEB_DIRECTORY, "nodes", "shared"];
/** Folders of the editor and of tools, never part of a published story even when code names a file in them. */
const UNPUBLISHED_DIRECTORIES = new Set(["editor", "schemas", "canvas", "node_modules", "dist"]);

/**
 * The project files a published web story needs: its page, runtime, graph,
 * Scenes, and shared code, the assets the graph declares, and any other
 * project file that code names by its path, such as a font a stylesheet
 * uses. Editor files, schemas, the runtime manifest, and unused assets stay
 * out. Throws when a declared asset
 * is not a project file, such as a Library asset that was never copied in.
 */
export async function publishableWebStoryFiles(workspacePath: string): Promise<string[]> {
  const graph = JSON.parse((await readText(workspacePath, "graph.json")) ?? "null") as NodeGraph | null;
  if (!graph) throw new Error("This project has no graph.json.");
  const files = new Set<string>();
  for (const relative of PLAYED_FILES) if ((await readText(workspacePath, relative)) !== undefined) files.add(relative);
  for (const directory of PLAYED_DIRECTORIES) {
    for (const relative of await listFiles(workspacePath, directory)) {
      if (relative !== STORY_WEB_MANIFEST && !path.posix.basename(relative).startsWith(".")) files.add(relative);
    }
  }
  for (const [id, asset] of Object.entries(graph.assets)) {
    if (asset.source.kind !== "workspace")
      throw new Error(`Asset "${id}" is in the Library, not the project. Copy it into the project from the Story canvas, or replace it.`);
    files.add(asset.source.path);
  }
  // Code can name a file by its path rather than declare it.
  const code = (await Promise.all([...files].filter((relative) => /\.(?:html|css|m?js|json|txt)$/.test(relative))
    .map((relative) => readText(workspacePath, relative)))).join("\n");
  for (const relative of await listFiles(workspacePath, ".")) {
    const top = relative.split("/")[0]!;
    if (files.has(relative) || top.startsWith(".") || UNPUBLISHED_DIRECTORIES.has(top) || !relative.includes("/")) continue;
    if (code.includes(relative)) files.add(relative);
  }
  return [...files].sort();
}

async function listFiles(workspacePath: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string) => {
    let entries;
    try {
      entries = await readdir(path.join(workspacePath, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative === "." ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  await walk(directory);
  return files;
}

export interface StoryWebUpgrade {
  /** Library assets copied into the project, by Asset ID. */
  copiedAssets: string[];
  /** Library assets that could not be found; they stay as they were. */
  missingAssets: string[];
  /** Node and shared files whose imports were rewritten for the browser. */
  rewritten: string[];
  runtime: StoryRuntimeInstall;
}

/**
 * Turns a sandboxed Interactive Story into a web story in place: the
 * Library assets it uses become project files, imports a browser cannot
 * load on its own are rewritten, and the page and runtime are added. The
 * caller takes a checkpoint first, so the author can undo it.
 */
export async function upgradeToWebStory(
  workspacePath: string,
  libraryFile: (assetId: string) => Promise<string | undefined>,
): Promise<StoryWebUpgrade> {
  const graphText = await readText(workspacePath, "graph.json");
  if (graphText === undefined) throw new Error("This project has no graph.json.");
  const graph = JSON.parse(graphText) as NodeGraph;
  // Check the shipped runtime before copying media or rewriting project code.
  await storyWebRuntimeModules();
  const { copiedAssets, missingAssets } = await copyLibraryAssets(workspacePath, libraryFile);

  const rewritten: string[] = [];
  for (const relative of await moduleFiles(workspacePath)) {
    const before = (await readText(workspacePath, relative))!;
    const after = browserImports(before);
    if (after === before) continue;
    await writeText(workspacePath, relative, after);
    rewritten.push(relative);
  }
  const runtime = await installStoryRuntime(workspacePath);
  await writeText(workspacePath, "index.html", storyWebIndexHtml(graph.title));
  // The guides OhMyGame wrote gain the web story rules; ones the author changed stay theirs.
  for (const [relative, content] of [["AGENTS.md", AGENT_INSTRUCTIONS], ["README.md", PROJECT_DOCUMENTATION]] as const) {
    const current = await readText(workspacePath, relative);
    if (current !== undefined && PROJECT_GUIDE_UPGRADES[relative].includes(hash(current))) await writeText(workspacePath, relative, content);
  }
  return { copiedAssets, missingAssets, rewritten, runtime };
}

/** Asset IDs the story still takes from the Library rather than the project. */
export async function libraryAssets(workspacePath: string): Promise<string[]> {
  const graph = JSON.parse((await readText(workspacePath, "graph.json")) ?? "null") as NodeGraph | null;
  return graph ? Object.entries(graph.assets).filter(([, asset]) => asset.source.kind === "library").map(([id]) => id) : [];
}

/**
 * Copies the Library assets the story uses into `assets/library/` and points
 * the graph at the copies, so the project holds everything it plays.
 * Assets the Library no longer has stay as they were.
 */
export async function copyLibraryAssets(
  workspacePath: string,
  libraryFile: (assetId: string) => Promise<string | undefined>,
): Promise<{ copiedAssets: string[]; missingAssets: string[] }> {
  const graphText = await readText(workspacePath, "graph.json");
  if (graphText === undefined) throw new Error("This project has no graph.json.");
  const graph = JSON.parse(graphText) as NodeGraph;
  const copiedAssets: string[] = [];
  const missingAssets: string[] = [];
  for (const [id, asset] of Object.entries(graph.assets)) {
    if (asset.source.kind !== "library") continue;
    const source = await libraryFile(asset.source.assetId);
    if (!source) {
      missingAssets.push(id);
      continue;
    }
    const relative = `assets/library/${safeName(id)}${path.extname(source)}`;
    const destination = await resolveWorkspaceMutationPath(workspacePath, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    asset.source = { kind: "workspace", path: relative };
    copiedAssets.push(id);
  }
  if (copiedAssets.length) await writeText(workspacePath, "graph.json", `${JSON.stringify(graph, null, 2)}\n`);
  return { copiedAssets, missingAssets };
}

/**
 * Rewrites the imports the sandbox compiler bundled but a browser cannot load
 * on its own: a text file becomes a fetch from beside the module, and a JSON
 * import gets its import attribute.
 */
export function browserImports(source: string): string {
  return source
    .replace(/^import\s+(\w+)\s+from\s+(["'])(\.[^"']+\.txt)\2;?[ \t]*$/gm, (_, name: string, _quote, specifier: string) =>
      `const ${name} = await (await fetch(new URL(${JSON.stringify(specifier)}, import.meta.url))).text();`)
    .replace(/^import\s+(\w+)\s+from\s+(["'])(\.[^"']+\.json)\2;?[ \t]*$/gm, (_, name: string, _quote, specifier: string) =>
      `import ${name} from ${JSON.stringify(specifier)} with { type: "json" };`);
}

function runtimeVersion(modules: Record<string, string>): string {
  const digest = createHash("sha256");
  for (const relative of Object.keys(modules).sort()) digest.update(relative).update("\0").update(modules[relative]!).update("\0");
  return digest.digest("hex").slice(0, 12);
}

async function readManifest(workspacePath: string): Promise<StoryWebManifest | undefined> {
  const text = await readText(workspacePath, STORY_WEB_MANIFEST);
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<StoryWebManifest>;
    return typeof value.version === "string" && value.files && typeof value.files === "object"
      ? { version: value.version, files: value.files, ...(value.pending ? { pending: value.pending } : {}) }
      : undefined;
  } catch {
    // An unreadable manifest treats every runtime file as the author's.
    return undefined;
  }
}

/** JavaScript the project's Scenes and shared modules are made of. */
async function moduleFiles(workspacePath: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (relative: string) => {
    let entries;
    try {
      entries = await readdir(path.join(workspacePath, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (/\.m?js$/.test(entry.name)) files.push(child);
    }
  };
  await walk("nodes");
  await walk("shared");
  return files.sort();
}

async function readText(workspacePath: string, relative: string): Promise<string | undefined> {
  try {
    return await readFile(await resolveWorkspaceMutationPath(workspacePath, relative), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function writeText(workspacePath: string, relative: string, content: string): Promise<void> {
  const file = await resolveWorkspaceMutationPath(workspacePath, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}
