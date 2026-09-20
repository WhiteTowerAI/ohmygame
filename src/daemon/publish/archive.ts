import { spawn, type ChildProcess } from "node:child_process";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { LibraryAsset, ProjectState, StoryDocument } from "../../shared/contracts.js";
import { PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES } from "../../shared/plugins.js";
import { PUBLISH_ARTIFACT_MAX_BYTES, PUBLISH_GAME_COVER_PATH } from "../../shared/publish-v1.js";
import { resolveStoryAssetId, validatePlayableChapter } from "../../shared/story.js";
import type { AssetLibrary } from "../asset-library.js";
import { readStoryCodebase } from "../story-codebase.js";

interface PackageJson {
  scripts?: { build?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

export class PublishError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
  }
}

export class ArtifactBuilder {
  readonly #running = new Map<string, ChildProcess>();

  constructor(private readonly library?: AssetLibrary, private readonly playerDirectory?: string) {}

  async create(project: ProjectState, cover?: Buffer): Promise<Buffer> {
    return this.#create(project, cover, PUBLISH_ARTIFACT_MAX_BYTES);
  }

  async buildInteractiveDrama(project: ProjectState): Promise<Buffer> {
    if (project.type !== "interactive-drama") throw new PublishError("Build requires an Interactive Drama project");
    return this.#create(project);
  }

  async #create(project: ProjectState, cover?: Buffer, maxBytes?: number): Promise<Buffer> {
    let temporary: string | undefined;
    try {
      let source: string;
      if (project.type === "interactive-drama") {
        temporary = await prepareInteractiveDrama(project, this.library, this.playerDirectory);
        source = temporary;
      } else {
        source = await prepareSource(project.workspacePath, (child) => this.#running.set(project.id, child));
      }
      return await createZip(source, false, cover, maxBytes);
    } finally {
      this.#running.delete(project.id);
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#running.values()].map(terminate));
    this.#running.clear();
  }
}

async function prepareInteractiveDrama(project: ProjectState, library?: AssetLibrary, playerDirectory?: string): Promise<string> {
  if (!library || !playerDirectory || !await exists(path.join(playerDirectory, "index.html"))) {
    throw new PublishError("Interactive Drama Player is not built. Run npm run build:player first.");
  }
  let story: StoryDocument;
  try {
    story = await readStoryCodebase(project.workspacePath);
  } catch {
    throw new PublishError("Interactive Drama story.json is missing or invalid");
  }
  if (story.chapters.length !== 1) {
    throw new PublishError("Build and publish currently support one chapter per Interactive Drama.");
  }
  const assets = new Map(library.list().map((asset) => [asset.id, asset]));
  validatePublishedStory(story, assets);
  const requiredIds = referencedAssetIds(story);
  const output = await mkdtemp(path.join(tmpdir(), "ohmygame-story-build-"));
  try {
    await cp(playerDirectory, output, { recursive: true });
    await mkdir(path.join(output, "assets", "media"), { recursive: true });
    const assetPaths: Record<string, string> = {};
    for (const assetId of [...requiredIds].sort()) {
      const { asset, absolutePath } = await library.content(assetId);
      const extension = path.extname(asset.name).toLowerCase();
      const relative = `assets/media/${asset.id}${extension}`;
      await copyFile(absolutePath, path.join(output, ...relative.split("/")));
      assetPaths[asset.id] = `./${relative}`;
    }
    const { editorLayout: _editorLayout, ...runtimeStory } = story;
    await writeFile(path.join(output, "story.json"), `${JSON.stringify(runtimeStory, null, 2)}\n`);
    await writeFile(path.join(output, "manifest.json"), `${JSON.stringify({
      version: 1,
      story: "story.json",
      scope: `published:${project.id}`,
      assets: assetPaths,
    }, null, 2)}\n`);
    return output;
  } catch (cause) {
    await rm(output, { recursive: true, force: true });
    throw cause;
  }
}

function validatePublishedStory(story: StoryDocument, assets: ReadonlyMap<string, LibraryAsset>): void {
  const availableAssets = new Map([...assets.values()].flatMap((asset) => asset.mediaType === "model" ? [] : [[asset.id, asset.mediaType] as const]));
  for (const chapter of story.chapters) {
    const issue = validatePlayableChapter(chapter, { availableAssets });
    if (issue) throw new PublishError(`${chapter.title || "Untitled chapter"}: ${issue.message}`);
  }
  for (const chapter of story.chapters) for (const node of chapter.nodes) {
    if ((node.type !== "open-ui" && node.type !== "scene" && node.type !== "interaction" && node.type !== "choice" && node.type !== "ending") || node.data.presentation?.media.mode !== "own") continue;
    for (const item of node.data.presentation.media.items) {
      const assetId = resolveStoryAssetId(chapter, item.source);
      if (!assetId || assets.get(assetId)?.mediaType !== item.type) {
        throw new PublishError(`${node.data.title || "Untitled node"} references a missing or incompatible ${item.type} asset.`);
      }
    }
  }
}

function referencedAssetIds(story: StoryDocument): Set<string> {
  const ids = new Set<string>();
  for (const chapter of story.chapters) {
    for (const node of chapter.nodes) {
      if ((node.type !== "open-ui" && node.type !== "scene" && node.type !== "interaction" && node.type !== "choice" && node.type !== "ending") || node.data.presentation?.media.mode !== "own") continue;
      for (const item of node.data.presentation.media.items) {
        const assetId = resolveStoryAssetId(chapter, item.source);
        if (assetId) ids.add(assetId);
      }
    }
  }
  return ids;
}

export async function createPluginArchive(source: string): Promise<Buffer> {
  return createZip(source, true, undefined, PUBLISH_ARTIFACT_MAX_BYTES);
}

async function prepareSource(workspacePath: string, track: (child: ChildProcess) => void): Promise<string> {
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson) {
    const build = packageJson.scripts?.build;
    if (typeof build !== "string" || !build.trim()) {
      throw new PublishError("Projects with package.json need a non-empty scripts.build command before publishing");
    }
    if (hasDependencies(packageJson) && !await exists(path.join(workspacePath, "node_modules"))) {
      await run(npmCommand(), ["install", "--no-audit", "--no-fund"], workspacePath, track);
    }
    await run(npmCommand(), ["run", "build"], workspacePath, track);
    const output = await findBuildOutput(workspacePath);
    if (!output) throw new PublishError("Build completed but did not produce a static index.html in dist, build, or out");
    return output;
  }
  if (await exists(path.join(workspacePath, "index.html"))) return workspacePath;
  throw new PublishError("Project has no build script or static index.html yet");
}

async function createZip(source: string, plugin = false, cover?: Buffer, maxBytes?: number): Promise<Buffer> {
  const zip = new ZipFile();
  const files = await filesIn(source, "", plugin);
  const zipOptions = { mtime: new Date(1980, 0, 2), forceDosTimestamp: true } as const;
  if (cover !== undefined && files.includes(PUBLISH_GAME_COVER_PATH)) {
    throw new PublishError(`Publish output uses reserved path: ${PUBLISH_GAME_COVER_PATH}`);
  }
  for (const file of files) {
    zip.addFile(path.join(source, ...file.split("/")), file, zipOptions);
  }
  if (cover !== undefined) zip.addBuffer(cover, PUBLISH_GAME_COVER_PATH, zipOptions);
  const chunks: Buffer[] = [];
  const output = zip.outputStream as Readable;
  const completed = new Promise<Buffer>((resolve, reject) => {
    let bytes = 0;
    output.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) {
        output.destroy(new PublishError("Publish artifact exceeds 25 MB", 413));
        return;
      }
      chunks.push(chunk);
    });
    output.once("error", reject);
    output.once("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  return completed;
}

async function filesIn(root: string, relative = "", plugin = false): Promise<string[]> {
  const files: string[] = [];
  const directory = path.join(root, relative);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored(entry.name, relative, plugin) || entry.isSymbolicLink()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesIn(root, child, plugin));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

async function readPackageJson(workspacePath: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PublishError("package.json is not valid JSON");
  }
}

function hasDependencies(packageJson: PackageJson): boolean {
  return Object.keys(packageJson.dependencies ?? {}).length > 0 || Object.keys(packageJson.devDependencies ?? {}).length > 0;
}

async function findBuildOutput(workspacePath: string): Promise<string | undefined> {
  for (const directory of ["dist", "build", "out"]) {
    const candidate = path.join(workspacePath, directory);
    if (await exists(path.join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

async function run(command: string, args: string[], cwd: string, track: (child: ChildProcess) => void): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  track(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new PublishError(stderr.trim() || `${command} exited with ${code}`)));
  });
}

function ignored(name: string, relative: string, plugin: boolean): boolean {
  if (name === "node_modules" || name === ".git" || name === ".data" || (!plugin && name === "AGENTS.md")) return true;
  if (!name.startsWith(".")) return false;
  return !(plugin && !relative && PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES.includes(name));
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      killer.once("error", reject);
      killer.once("exit", () => resolve());
    });
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
