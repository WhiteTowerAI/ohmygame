import { randomUUID } from "node:crypto";
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState, ProjectType, PublicationState, StoryDocument } from "../shared/contracts.js";
import { defaultProjectName } from "../shared/project-names.js";
import { deleteAssetMetadata, readAssetMetadata, renameAssetMetadata, writeAssetMetadata, writeAssetPublication, type AssetPublication } from "./asset-metadata.js";
import { createStoryDocument, isStoryDocument } from "../shared/story.js";
import { getWorkspaceMedia, listWorkspaceFiles, WorkspaceError } from "./workspace.js";
import type { AssetLibrary } from "./asset-library.js";

interface ProjectMetadata {
  version: 1;
  id: string;
  name: string;
  type: ProjectType;
  updatedAt: string;
  publication?: PublicationState;
}

export class ProjectAssetError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

interface LoadedMetadata {
  metadata: ProjectMetadata;
  missing: boolean;
}

const PROJECT_COVER_FILE = "cover.webp";
const STORY_FILE = "story.json";

export class ProjectManager {
  readonly #projects = new Map<string, ProjectState>();
  readonly #assetMetadataWrites = new Map<string, Promise<unknown>>();
  readonly #projectsDirectory: string;

  constructor(dataDirectory: string, private readonly assetLibrary?: AssetLibrary) {
    this.#projectsDirectory = path.join(dataDirectory, "projects");
  }

  async load(): Promise<void> {
    await mkdir(this.#projectsDirectory, { recursive: true });
    const entries = await readdir(this.#projectsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isProjectId(entry.name)) continue;
      const projectDirectory = path.join(this.#projectsDirectory, entry.name);
      const workspacePath = path.join(projectDirectory, "workspace");
      if (!await exists(workspacePath)) continue;
      const { metadata, missing } = await readMetadata(projectDirectory, entry.name, (await lstat(projectDirectory)).mtime.toISOString());
      const project = projectState(
        workspacePath,
        metadata,
        await isRunnableWorkspace(workspacePath),
      );
      this.#projects.set(project.id, project);
      if (missing) await writeMetadata(projectDirectory, metadata);
    }
  }

  async create(name?: string, type: ProjectType = "web-game"): Promise<ProjectState> {
    const id = randomUUID();
    const projectDirectory = path.join(this.#projectsDirectory, id);
    const workspacePath = path.join(projectDirectory, "workspace");
    const metadata: ProjectMetadata = {
      version: 1,
      id,
      name: name?.trim() || defaultProjectName(type),
      type,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(projectDirectory, { recursive: true });
    await mkdir(workspacePath, { recursive: true });
    await writeMetadata(projectDirectory, metadata);
    const project = projectState(workspacePath, metadata, false);
    this.#projects.set(id, project);
    return project;
  }

  list(): ProjectState[] {
    return [...this.#projects.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): ProjectState | undefined { return this.#projects.get(id); }

  async syncLibraryAssets(): Promise<void> {
    if (!this.assetLibrary) return;
    for (const project of this.#projects.values()) {
      const files = (await listWorkspaceFiles(project.workspacePath)).filter((file) => (
        file.mediaType && (!file.libraryAssetId || !this.assetLibrary!.get(file.libraryAssetId))
      ));
      for (const file of files) {
        const media = await getWorkspaceMedia(project.workspacePath, file.path);
        const asset = await this.assetLibrary.addFile(path.basename(file.path), media.absolutePath, {
          ...(file.prompt ? { prompt: file.prompt } : {}),
          ...(file.publication ? { publication: file.publication } : {}),
          sourceKey: `project:${project.id}:${file.path}`,
        });
        await this.#writeAssetMetadata(project.id, () => writeAssetMetadata(project.workspacePath, file.path, { libraryAssetId: asset.id }));
      }
    }
  }

  async rename(id: string, name: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const normalized = name.trim();
    if (!normalized) throw new Error("Project name must not be empty");
    await this.#save(project, { name: normalized, updatedAt: new Date().toISOString() });
    return project;
  }

  async renameIfCurrent(id: string, expectedName: string, name: string): Promise<ProjectState | undefined> {
    const project = this.#projects.get(id);
    if (!project || project.name !== expectedName) return undefined;
    const normalized = name.trim();
    if (!normalized) throw new Error("Project name must not be empty");
    if (normalized === expectedName) return undefined;
    await this.#save(project, { name: normalized, updatedAt: new Date().toISOString() });
    return project;
  }

  async duplicate(id: string): Promise<ProjectState> {
    const source = this.#projects.get(id);
    if (!source) throw new Error(`Project not found: ${id}`);
    const duplicateId = randomUUID();
    const duplicateDirectory = path.join(this.#projectsDirectory, duplicateId);
    const updatedAt = new Date().toISOString();
    const metadata: ProjectMetadata = {
      version: 1,
      id: duplicateId,
      name: `${source.name} copy`,
      type: source.type,
      updatedAt,
    };
    try {
      await cp(source.workspacePath, path.join(duplicateDirectory, "workspace"), {
        recursive: true,
        errorOnExist: true,
        filter: (sourcePath) => path.basename(sourcePath) !== "node_modules",
      });
      await copyFile(projectCoverPath(source.workspacePath), path.join(duplicateDirectory, PROJECT_COVER_FILE)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      await writeMetadata(duplicateDirectory, metadata);
    } catch (error) {
      await rm(duplicateDirectory, { recursive: true, force: true });
      throw error;
    }
    const project = projectState(path.join(duplicateDirectory, "workspace"), metadata, await isRunnableWorkspace(path.join(duplicateDirectory, "workspace")));
    this.#projects.set(project.id, project);
    return project;
  }

  async delete(id: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await rm(path.dirname(project.workspacePath), { recursive: true, force: false });
    this.#projects.delete(id);
    return project;
  }

  async touch(id: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await this.#save(project, { updatedAt: new Date().toISOString() });
  }

  async cover(id: string): Promise<Buffer | undefined> {
    const project = this.#projects.get(id);
    if (!project) return undefined;
    try {
      return await readFile(projectCoverPath(project.workspacePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async setCover(id: string, contents: Uint8Array): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const destination = projectCoverPath(project.workspacePath);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async addGeneratedAsset(
    id: string,
    fileName: string,
    contents: Uint8Array,
    metadata: { prompt?: string; preview?: { bytes: Uint8Array; extension: "png" | "jpg" }; libraryAssetId?: string } = {},
  ): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(fileName)) throw new Error(`Invalid asset name: ${fileName}`);
    const assetsDirectory = path.join(project.workspacePath, "assets");
    const generatedDirectory = path.join(assetsDirectory, "generated");
    await ensureDirectory(project.workspacePath);
    await ensureDirectory(assetsDirectory, true);
    await ensureDirectory(generatedDirectory, true);

    const relativePath = path.join("assets", "generated", fileName);
    const destination = path.join(generatedDirectory, fileName);
    const temporary = path.join(generatedDirectory, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    const assetPath = relativePath.split(path.sep).join("/");
    const normalizedPrompt = metadata.prompt?.trim();
    let previewPath: string | undefined;
    if (metadata.preview) {
      const dataDirectory = path.join(project.workspacePath, ".data");
      const previewDirectory = path.join(dataDirectory, "asset-previews");
      await ensureDirectory(dataDirectory, true);
      await ensureDirectory(previewDirectory, true);
      previewPath = `.data/asset-previews/${path.parse(fileName).name}.${metadata.preview.extension}`;
      const previewDestination = path.join(project.workspacePath, ...previewPath.split("/"));
      const previewTemporary = `${previewDestination}.${randomUUID()}.tmp`;
      try {
        await writeFile(previewTemporary, metadata.preview.bytes, { flag: "wx" });
        await rename(previewTemporary, previewDestination);
      } finally {
        await rm(previewTemporary, { force: true });
      }
    }
    const libraryAssetId = metadata.libraryAssetId && this.assetLibrary?.get(metadata.libraryAssetId)
      ? metadata.libraryAssetId
      : (await this.assetLibrary?.add(fileName, contents, {
      ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
      sourceKey: `project:${id}:${assetPath}`,
      }))?.id;
    if (normalizedPrompt || previewPath || libraryAssetId) {
      await this.#writeAssetMetadata(id, () => writeAssetMetadata(project.workspacePath, assetPath, {
        ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
        ...(previewPath ? { previewPath } : {}),
        ...(libraryAssetId ? { libraryAssetId } : {}),
      }));
    }
    await this.touch(id);
    return relativePath.split(path.sep).join("/");
  }

  async generatedAssetPrompt(id: string, assetPath: string): Promise<string | undefined> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return (await readAssetMetadata(project.workspacePath)).prompts[assetPath];
  }

  async assetPublication(id: string, assetPath: string): Promise<AssetPublication | undefined> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return (await readAssetMetadata(project.workspacePath)).publications[assetPath];
  }

  async setAssetPublication(id: string, assetPath: string, publication: AssetPublication): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await getWorkspaceMedia(project.workspacePath, assetPath);
    await this.#writeAssetMetadata(id, () => writeAssetPublication(project.workspacePath, assetPath, publication));
  }

  async materializeLibraryAsset(id: string, assetId: string): Promise<{ path: string; assetId: string }> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!this.assetLibrary) throw new ProjectAssetError("Asset Library is not configured", 503);
    const { asset, absolutePath } = await this.assetLibrary.content(assetId);
    return this.#writeAssetMetadata(id, async () => {
      const metadata = await readAssetMetadata(project.workspacePath);
      const stalePaths: string[] = [];
      for (const [assetPath, linkedId] of Object.entries(metadata.libraryAssets)) {
        if (linkedId !== assetId) continue;
        try {
          await getWorkspaceMedia(project.workspacePath, assetPath);
          return { path: assetPath, assetId };
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          stalePaths.push(assetPath);
        }
      }
      const assetPath = await this.#storeImportedAsset(id, asset.name, (temporary) => copyFile(absolutePath, temporary));
      for (const stalePath of stalePaths) await deleteAssetMetadata(project.workspacePath, stalePath);
      await writeAssetMetadata(project.workspacePath, assetPath, { libraryAssetId: assetId });
      return { path: assetPath, assetId };
    });
  }

  async #storeImportedAsset(id: string, fileName: string, writeTemporary: (temporary: string) => Promise<unknown>): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(fileName)) throw new ProjectAssetError("Invalid asset name", 400);
    const assetsDirectory = path.join(project.workspacePath, "assets");
    const importedDirectory = path.join(assetsDirectory, "imported");
    await ensureDirectory(project.workspacePath);
    await ensureDirectory(assetsDirectory, true);
    await ensureDirectory(importedDirectory, true);
    const parsed = path.parse(fileName);
    let candidate = fileName;
    for (let suffix = 2; await exists(path.join(importedDirectory, candidate)); suffix += 1) {
      candidate = `${parsed.name}-${suffix}${parsed.ext}`;
    }
    const destination = path.join(importedDirectory, candidate);
    const temporary = path.join(importedDirectory, `.${candidate}.${randomUUID()}.tmp`);
    try {
      await writeTemporary(temporary);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    await this.touch(id);
    return path.posix.join("assets", "imported", candidate);
  }

  async renameAsset(id: string, assetPath: string, name: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const normalizedName = name.trim();
    if (!validAssetName(normalizedName)) throw new ProjectAssetError("Invalid asset name", 400);
    const source = await getWorkspaceMedia(project.workspacePath, assetPath);
    const extension = path.extname(source.absolutePath);
    const destination = path.join(path.dirname(source.absolutePath), `${normalizedName}${extension}`);
    if (destination === source.absolutePath) return assetPath;
    try {
      await lstat(destination);
      throw new ProjectAssetError("An asset with that name already exists", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const renamedPath = path.posix.join(path.posix.dirname(source.relativePath), `${normalizedName}${extension}`);
    await rename(source.absolutePath, destination);
    try {
      await this.#writeAssetMetadata(id, () => renameAssetMetadata(project.workspacePath, source.relativePath, renamedPath));
    } catch (error) {
      await rename(destination, source.absolutePath);
      throw error;
    }
    await this.touch(id);
    return renamedPath;
  }

  async deleteAsset(id: string, assetPath: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const asset = await getWorkspaceMedia(project.workspacePath, assetPath);
    const removed = `${asset.absolutePath}.${randomUUID()}.removed`;
    await rename(asset.absolutePath, removed);
    let previewPath: string | undefined;
    try {
      await this.#writeAssetMetadata(id, async () => {
        previewPath = await deleteAssetMetadata(project.workspacePath, asset.relativePath);
      });
    } catch (error) {
      await rename(removed, asset.absolutePath);
      throw error;
    }
    await rm(removed);
    if (previewPath) {
      const dataDirectory = path.join(project.workspacePath, ".data");
      const previewDirectory = path.join(dataDirectory, "asset-previews");
      await ensureDirectory(dataDirectory);
      await ensureDirectory(previewDirectory);
      await rm(path.join(project.workspacePath, ...previewPath.split("/")), { force: true });
    }
    await this.touch(id);
  }

  async #writeAssetMetadata<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const write = (this.#assetMetadataWrites.get(id)?.catch(() => {}) ?? Promise.resolve()).then(operation);
    this.#assetMetadataWrites.set(id, write);
    try {
      return await write;
    } finally {
      if (this.#assetMetadataWrites.get(id) === write) this.#assetMetadataWrites.delete(id);
    }
  }

  async story(id: string): Promise<StoryDocument> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.type !== "interactive-drama") throw new Error("Story documents require an Interactive Drama project");
    const destination = path.join(project.workspacePath, STORY_FILE);
    try {
      const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
      if (!isStoryDocument(parsed)) throw new Error(`Invalid story document: ${destination}`);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const story = createStoryDocument();
      await writeStory(destination, story);
      return story;
    }
  }

  async setStory(id: string, story: StoryDocument): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.type !== "interactive-drama") throw new Error("Story documents require an Interactive Drama project");
    if (!isStoryDocument(story)) throw new Error("Invalid story document");
    await writeStory(path.join(project.workspacePath, STORY_FILE), story);
    await this.touch(id);
  }

  async referencesLibraryAsset(assetId: string): Promise<ProjectState[]> {
    const references: ProjectState[] = [];
    for (const project of this.#projects.values()) {
      const metadata = await readAssetMetadata(project.workspacePath);
      if (Object.values(metadata.libraryAssets).includes(assetId)) {
        references.push(project);
        continue;
      }
      if (project.type !== "interactive-drama") continue;
      let story: StoryDocument;
      try {
        const parsed: unknown = JSON.parse(await readFile(path.join(project.workspacePath, STORY_FILE), "utf8"));
        // Older Story documents do not contain global asset references. They must not
        // prevent unrelated Library assets from being deleted.
        if (!isStoryDocument(parsed)) continue;
        story = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (story.chapters.some((chapter) => chapter.nodes.some((node) => (
        node.type === "scene" && node.data.clips.some((clip) => clip.assetId === assetId)
      )))) references.push(project);
    }
    return references;
  }

  async removeLibraryAssetReferences(assetId: string): Promise<void> {
    for (const project of await this.referencesLibraryAsset(assetId)) {
      const metadata = await readAssetMetadata(project.workspacePath);
      for (const [assetPath, linkedId] of Object.entries(metadata.libraryAssets)) {
        if (linkedId !== assetId) continue;
        try {
          await this.deleteAsset(project.id, assetPath);
        } catch (error) {
          if (!(error instanceof WorkspaceError)) throw error;
          await this.#writeAssetMetadata(project.id, () => deleteAssetMetadata(project.workspacePath, assetPath));
        }
      }
      if (project.type !== "interactive-drama") continue;
      const destination = path.join(project.workspacePath, STORY_FILE);
      try {
        const parsed: unknown = JSON.parse(await readFile(destination, "utf8"));
        if (!isStoryDocument(parsed)) continue;
        const story: StoryDocument = {
          ...parsed,
          chapters: parsed.chapters.map((chapter) => ({
            ...chapter,
            nodes: chapter.nodes.map((node) => node.type === "scene"
              ? { ...node, data: { ...node.data, clips: node.data.clips.filter((clip) => clip.assetId !== assetId) } }
              : node),
          })),
        };
        await writeStory(destination, story);
        await this.touch(project.id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async setPublication(id: string, publication: PublicationState): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await this.#save(project, { publication, updatedAt: new Date().toISOString() });
  }

  async #save(
    project: ProjectState,
    changes: Partial<Pick<ProjectMetadata, "name" | "updatedAt" | "publication">>,
  ): Promise<void> {
    const metadata = { ...metadataFor(project), ...changes };
    await writeMetadata(path.dirname(project.workspacePath), metadata);
    project.name = metadata.name;
    project.updatedAt = metadata.updatedAt;
    if (metadata.publication) project.publication = metadata.publication;
    else delete project.publication;
  }
}

function projectCoverPath(workspacePath: string): string {
  return path.join(path.dirname(workspacePath), PROJECT_COVER_FILE);
}

function projectState(
  workspacePath: string,
  metadata: ProjectMetadata,
  runnable: boolean,
): ProjectState {
  return {
    id: metadata.id,
    name: metadata.name,
    type: metadata.type,
    updatedAt: metadata.updatedAt,
    workspacePath,
    preview: { status: runnable ? "stopped" : "waiting" },
    ...(metadata.publication ? { publication: metadata.publication } : {}),
  };
}

export async function isRunnableWorkspace(workspacePath: string): Promise<boolean> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as {
      scripts?: { dev?: unknown };
    };
    return typeof packageJson.scripts?.dev === "string" && packageJson.scripts.dev.trim().length > 0;
  } catch {
    return false;
  }
}

async function readMetadata(projectDirectory: string, id: string, fallbackUpdatedAt: string): Promise<LoadedMetadata> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8")) as Partial<ProjectMetadata>;
    if (
      parsed.version === 1 && parsed.id === id && typeof parsed.name === "string" && parsed.name.trim() &&
      (parsed.type === undefined || parsed.type === "web-game" || parsed.type === "godot-game" || parsed.type === "interactive-drama") &&
      (parsed.publication === undefined || validPublication(parsed.publication))
    ) {
      const updatedAt = typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : fallbackUpdatedAt;
      const type = parsed.type ?? "web-game";
      return {
        metadata: {
          version: 1,
          id,
          name: parsed.name.trim(),
          type,
          updatedAt,
          ...(parsed.publication ? { publication: parsed.publication } : {}),
        },
        missing: parsed.updatedAt !== updatedAt || parsed.type !== type,
      };
    }
    throw new Error(`Invalid project metadata: ${path.join(projectDirectory, "project.json")}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { metadata: { version: 1, id, name: "Untitled project", type: "web-game", updatedAt: fallbackUpdatedAt }, missing: true };
  }
}

function metadataFor(project: ProjectState): ProjectMetadata {
  return {
    version: 1,
    id: project.id,
    name: project.name,
    type: project.type,
    updatedAt: project.updatedAt,
    ...(project.publication ? { publication: project.publication } : {}),
  };
}

async function writeMetadata(projectDirectory: string, metadata: ProjectMetadata): Promise<void> {
  const destination = path.join(projectDirectory, "project.json");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeStory(destination: string, story: StoryDocument): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(story, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(target: string, create = false): Promise<void> {
  if (create) {
    try {
      await mkdir(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Unsafe generated asset path: ${target}`);
}

function isProjectId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validAssetName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value !== "." && value !== ".." &&
    !value.includes("/") && !value.includes("\\") && !/[\u0000-\u001f]/.test(value);
}

function validPublication(value: unknown): value is PublicationState {
  if (!value || typeof value !== "object") return false;
  const publication = value as Partial<PublicationState>;
  return typeof publication.gameId === "string" && typeof publication.deploymentId === "string" &&
    typeof publication.playUrl === "string" && typeof publication.publishedAt === "string" &&
    (publication.title === undefined || typeof publication.title === "string") &&
    (publication.description === undefined || typeof publication.description === "string");
}
