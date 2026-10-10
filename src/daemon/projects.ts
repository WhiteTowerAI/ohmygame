import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LibraryAssetProject, MediaModelDefaults, PreviewViewport, ProjectCoverMode, ProjectCoverState, ProjectPackageManager, ProjectRunSettings, ProjectState, ProjectType, PublicationState } from "../shared/contracts.js";
import { defaultProjectName } from "../shared/project-names.js";
import { isProjectType, isWebRuntimeProjectType, supportsWebPreview } from "../shared/project-runtime.js";
import { deleteAssetMetadata, readAssetMetadata, renameAssetMetadata, writeAssetMetadata } from "./asset-metadata.js";
import { getWorkspaceMedia, resolveWorkspaceDirectory, resolveWorkspaceEntry, WorkspaceError } from "./workspace.js";
import type { AssetLibrary } from "./asset-library.js";
import { isProjectPackageManager } from "./package-manager.js";
import { validateNodeGraph } from "../shared/playable-graph-validation.js";
import type { NodeGraph } from "../shared/playable-nodes.js";
import { readNodeCodebase, writeNodeCodebase } from "./playable-codebase.js";
import { canvasLibraryAssetUsage, canvasReferencesAsset, removeCanvasAssetReferences, renameCanvasAssetPaths } from "./canvas-workspace.js";
import { readCanvasAssets } from "./canvas-assets.js";
import { ProjectCovers } from "./project-covers.js";

const PROJECT_LOAD_CONCURRENCY = 8;

interface ProjectMetadata {
  version: 1;
  id: string;
  name: string;
  type: ProjectType;
  updatedAt: string;
  webPreviewEnabled?: boolean;
  /** Present only when a Web Game starts from a directory below its workspace root. */
  startupDirectory?: string;
  /** Present only when a Web Game starts with a script other than `dev`. */
  startupScript?: string;
  /** Present only when automatic package-manager detection is overridden. */
  packageManager?: ProjectPackageManager;
  /** Present only when a Web Game preview starts below the root route. */
  previewPath?: string;
  /** Present only when a Web Game preview defaults to a device preset other than fit. */
  previewViewport?: PreviewViewport;
  /** Present only when the user chose a workspace outside OhMyGame storage. */
  workspacePath?: string;
  publication?: PublicationState;
  mediaModelDefaults?: MediaModelDefaults;
}

export class ProjectLibraryReferenceError extends Error {}

export class ProjectWorkspaceError extends Error {}

export class ProjectAssetError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

interface LoadedMetadata {
  metadata: ProjectMetadata;
  missing: boolean;
}

const PLAYABLE_GRAPH_FILE = "graph.json";

function workspaceEntryName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/<>:"|?*\x00-\x1f]/.test(name) || name.endsWith(".")) throw new ProjectAssetError("Invalid file or folder name", 400);
  return name;
}

function assertEditableWorkspacePath(value: string): void {
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => [".git", ".data", ".ohmygame"].includes(part))) throw new ProjectAssetError("Internal project files cannot be changed here", 400);
  if (parts[0] === "canvas") throw new ProjectAssetError("Manage Canvas documents and boards in Design", 409);
}

async function assetDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class ProjectManager {
  readonly #projects = new Map<string, ProjectState>();
  readonly #metadataWrites = new Map<string, Promise<void>>();
  readonly #covers = new ProjectCovers();
  readonly #assetMetadataWrites = new Map<string, Promise<unknown>>();
  readonly #workspaceWrites = new Map<string, Promise<unknown>>();
  readonly #projectsDirectory: string;

  constructor(dataDirectory: string, private readonly assetLibrary?: AssetLibrary) {
    this.#projectsDirectory = path.join(dataDirectory, "projects");
  }

  async load(): Promise<void> {
    await mkdir(this.#projectsDirectory, { recursive: true });
    const entries = await readdir(this.#projectsDirectory, { withFileTypes: true });
    const projects = await mapConcurrent(
      entries.filter((entry) => entry.isDirectory() && isProjectId(entry.name)),
      PROJECT_LOAD_CONCURRENCY,
      async (entry) => {
        const projectDirectory = path.join(this.#projectsDirectory, entry.name);
        const { metadata, missing } = await readMetadata(projectDirectory, entry.name, (await lstat(projectDirectory)).mtime.toISOString());
        const workspacePath = metadata.workspacePath ?? path.join(projectDirectory, "workspace");
        const workspaceAvailable = await isDirectory(workspacePath);
        const project = projectState(
          workspacePath,
          metadata,
          await isRunnableStartupWorkspace({ ...metadata, workspacePath }),
          projectDirectory,
          workspaceAvailable,
        );
        if (missing) await writeMetadata(projectDirectory, metadata);
        return project;
      },
    );
    for (const project of projects) {
      this.#projects.set(project.id, project);
    }
  }

  async create(name?: string, type: ProjectType = "web-game", selectedWorkspacePath?: string): Promise<ProjectState> {
    const id = randomUUID();
    const projectDirectory = path.join(this.#projectsDirectory, id);
    const hasExternalWorkspace = selectedWorkspacePath !== undefined;
    const workspacePath = hasExternalWorkspace
      ? await this.#validateExternalWorkspace(selectedWorkspacePath)
      : path.join(projectDirectory, "workspace");
    const metadata: ProjectMetadata = {
      version: 1,
      id,
      name: name?.trim() || defaultProjectName(type),
      type,
      ...(type === "general" ? { webPreviewEnabled: false } : {}),
      updatedAt: new Date().toISOString(),
      ...(hasExternalWorkspace ? { workspacePath } : {}),
    };
    await mkdir(projectDirectory, { recursive: true });
    if (!hasExternalWorkspace) {
      await mkdir(workspacePath, { recursive: true });
    }
    await writeMetadata(projectDirectory, metadata);
    const project = projectState(workspacePath, metadata, await isRunnableStartupWorkspace({ ...metadata, workspacePath }), projectDirectory, true);
    this.#projects.set(id, project);
    return project;
  }

  list(): ProjectState[] {
    return [...this.#projects.values()]
      .map((project, index) => ({ project, index }))
      .sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt) || right.index - left.index)
      .map(({ project }) => project);
  }

  get(id: string): ProjectState | undefined { return this.#projects.get(id); }

  async ensureLibraryAsset(id: string, assetPath: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!this.assetLibrary) throw new ProjectAssetError("Asset Library is not configured", 503);
    const metadata = await readAssetMetadata(project.workspacePath);
    const media = await getWorkspaceMedia(project.workspacePath, assetPath);
    const digest = await assetDigest(media.absolutePath);
    const existing = metadata.libraryAssets[media.relativePath];
    if (existing && this.assetLibrary.get(existing)) {
      const original = await this.assetLibrary.content(existing);
      if (await assetDigest(original.absolutePath) === digest) return existing;
    }
    const asset = await this.assetLibrary.addFile(path.basename(assetPath), media.absolutePath, {
      origin: metadata.origins[media.relativePath] ?? "workspace",
      purpose: metadata.purposes[media.relativePath],
      ...(metadata.prompts[assetPath] ? { prompt: metadata.prompts[assetPath] } : {}),
      sourceKey: `project:${id}:${media.relativePath}:${digest}`,
    });
    await this.#writeAssetMetadata(id, () => writeAssetMetadata(project.workspacePath, media.relativePath, { libraryAssetId: asset.id }));
    return asset.id;
  }

  async rename(id: string, name: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const normalized = name.trim();
    if (!normalized) throw new Error("Project name must not be empty");
    await this.#save(project, { name: normalized, updatedAt: new Date().toISOString() });
    return project;
  }

  async setStartupDirectory(id: string, startupDirectory: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return this.setRunSettings(id, { ...projectRunSettings(project), startupDirectory });
  }

  async setRunSettings(id: string, input: ProjectRunSettings): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!isWebRuntimeProjectType(project.type)) throw new ProjectWorkspaceError("Run settings require a Web Game or General Game project");

    if (project.type !== "general" && input.webPreviewEnabled !== undefined) throw new ProjectWorkspaceError("Only General Game projects have a Web preview switch");
    if (input.webPreviewEnabled !== undefined && typeof input.webPreviewEnabled !== "boolean") throw new ProjectWorkspaceError("Web preview enabled must be a boolean");
    const webPreviewEnabled = project.type === "general" ? input.webPreviewEnabled ?? project.webPreviewEnabled ?? false : true;
    if (!isValidStartupDirectory(input.startupDirectory)) throw new ProjectWorkspaceError("Startup directory must be a relative path inside the project workspace");
    const startupDirectory = normalizeStartupDirectory(input.startupDirectory) ?? ".";
    const startupScript = normalizeStartupScript(input.startupScript);
    if (!startupScript) throw new ProjectWorkspaceError("Startup script must be a package.json script name");
    const previewPath = normalizePreviewPath(input.previewPath);
    if (previewPath === undefined) throw new ProjectWorkspaceError("Preview route must be a local path");
    const previewViewport = input.previewViewport;
    if (!isPreviewViewport(previewViewport)) throw new ProjectWorkspaceError("Preview device preset is not supported");
    const packageManager = input.packageManager;
    if (packageManager !== undefined && !isProjectPackageManager(packageManager)) {
      throw new ProjectWorkspaceError("Package manager is not supported");
    }
    const status = webPreviewEnabled
      ? await resolvePreviewWorkspace({ workspacePath: project.workspacePath, startupDirectory, startupScript })
      : undefined;
    if (project.type === "web-game" && !status?.runnable) throw new ProjectWorkspaceError(status?.error ?? "The startup directory is not runnable");
    const configuredDirectory = status?.relativePath ?? startupDirectory;

    await this.#save(project, {
      startupDirectory: configuredDirectory === "." ? undefined : configuredDirectory,
      startupScript: startupScript === "dev" ? undefined : startupScript,
      packageManager,
      previewPath: previewPath === "/" ? undefined : previewPath,
      previewViewport: previewViewport === "fit" ? undefined : previewViewport,
      ...(project.type === "general" ? { webPreviewEnabled } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (project.type === "general" && (!webPreviewEnabled || ["waiting", "stopped", "error"].includes(project.preview.status))) {
      project.preview = { status: status?.runnable ? "stopped" : "waiting" };
    }
    return project;
  }

  async setMediaModelDefaults(id: string, defaults: MediaModelDefaults): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!validMediaModelDefaults(defaults)) throw new Error("Invalid generation model defaults");
    await this.#save(project, {
      mediaModelDefaults: Object.keys(defaults).length ? structuredClone(defaults) : undefined,
      updatedAt: new Date().toISOString(),
    });
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
      ...(source.type === "general" ? { webPreviewEnabled: source.webPreviewEnabled ?? false } : {}),
      updatedAt,
      ...(source.startupDirectory ? { startupDirectory: source.startupDirectory } : {}),
      ...(source.startupScript ? { startupScript: source.startupScript } : {}),
      ...(source.packageManager ? { packageManager: source.packageManager } : {}),
      ...(source.previewPath ? { previewPath: source.previewPath } : {}),
      ...(source.previewViewport ? { previewViewport: source.previewViewport } : {}),
      ...(source.mediaModelDefaults ? { mediaModelDefaults: structuredClone(source.mediaModelDefaults) } : {}),
    };
    try {
      await cp(source.workspacePath, path.join(duplicateDirectory, "workspace"), {
        recursive: true,
        errorOnExist: true,
        filter: (sourcePath) => {
          const relative = path.relative(source.workspacePath, sourcePath).replaceAll(path.sep, "/");
          return path.basename(sourcePath) !== "node_modules" && relative !== ".data/agent-attachments";
        },
      });
      await this.#covers.copy(this.#projectDirectory(source.id), duplicateDirectory);
      await writeMetadata(duplicateDirectory, metadata);
    } catch (error) {
      await rm(duplicateDirectory, { recursive: true, force: true });
      throw error;
    }
    const workspacePath = path.join(duplicateDirectory, "workspace");
    const project = projectState(workspacePath, metadata, await isRunnableStartupWorkspace({ ...metadata, workspacePath }), duplicateDirectory, true);
    this.#projects.set(project.id, project);
    return project;
  }

  async delete(id: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.workspaceLocation === "external") {
      await rm(path.join(project.workspacePath, ".data", "agent-attachments"), { recursive: true, force: true });
    }
    await rm(this.#projectDirectory(id), { recursive: true, force: false });
    this.#projects.delete(id);
    return project;
  }

  /** Re-checks whether the workspace can start a preview, e.g. after files were added to it. */
  async refreshPreviewReadiness(id: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.preview.status !== "waiting" && project.preview.status !== "stopped") return project;
    const runnable = await isRunnableStartupWorkspace(project);
    project.preview = { status: runnable ? "stopped" : "waiting" };
    return project;
  }

  async touch(id: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await this.#save(project, { updatedAt: new Date().toISOString() });
  }

  async cover(id: string): Promise<Buffer | undefined> {
    if (!this.#projects.has(id)) return undefined;
    return this.#covers.read(this.#projectDirectory(id));
  }

  async coverState(id: string): Promise<ProjectCoverState> {
    if (!this.#projects.has(id)) throw new Error(`Project not found: ${id}`);
    return this.#covers.state(this.#projectDirectory(id));
  }

  async setCover(id: string, contents: Uint8Array, source: ProjectCoverMode = "custom"): Promise<void> {
    if (!this.#projects.has(id)) throw new Error(`Project not found: ${id}`);
    return this.#covers.set(this.#projectDirectory(id), contents, source);
  }

  async restoreAutomaticCover(id: string): Promise<void> {
    if (!this.#projects.has(id)) throw new Error(`Project not found: ${id}`);
    await this.#covers.restoreAutomatic(this.#projectDirectory(id));
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
      origin: "generated",
      ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
      sourceKey: `project:${id}:${assetPath}`,
      }))?.id;
    await this.#writeAssetMetadata(id, () => writeAssetMetadata(project.workspacePath, assetPath, {
      origin: "generated",
      purpose: "asset",
      ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
      ...(previewPath ? { previewPath } : {}),
      ...(libraryAssetId ? { libraryAssetId } : {}),
    }));
    await this.touch(id);
    return relativePath.split(path.sep).join("/");
  }

  async generatedAssetPrompt(id: string, assetPath: string): Promise<string | undefined> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return (await readAssetMetadata(project.workspacePath)).prompts[assetPath];
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
      await writeAssetMetadata(project.workspacePath, assetPath, { libraryAssetId: assetId, origin: asset.origin, purpose: asset.purpose });
      return { path: assetPath, assetId };
    });
  }

  async #storeImportedAsset(id: string, fileName: string, writeTemporary: (temporary: string) => Promise<unknown>): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!validAssetName(fileName)) throw new ProjectAssetError("Invalid asset name", 400);
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
    if (!validAssetName(name.trim())) throw new ProjectAssetError("Invalid asset name", 400);
    const source = await getWorkspaceMedia(project.workspacePath, assetPath);
    return this.renameWorkspaceEntry(id, assetPath, `${name.trim()}${path.extname(source.absolutePath)}`);
  }

  async deleteAsset(id: string, assetPath: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    await getWorkspaceMedia(project.workspacePath, assetPath);
    await this.deleteWorkspaceEntry(id, assetPath);
  }

  async createWorkspaceEntry(id: string, parent: string, name: string, kind: "file" | "folder"): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    const normalizedName = workspaceEntryName(name);
    const entryPath = path.posix.join(parent, normalizedName);
    assertEditableWorkspacePath(entryPath);
    return this.#mutateWorkspace(id, async () => {
      const directory = await resolveWorkspaceDirectory(project.workspacePath, parent);
      const destination = path.join(directory, normalizedName);
      try {
        if (kind === "folder") await mkdir(destination);
        else await writeFile(destination, "", { flag: "wx" });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectAssetError("A file or folder with that name already exists", 409);
        throw cause;
      }
      await this.touch(id);
      return entryPath;
    });
  }

  async renameWorkspaceEntry(id: string, entryPath: string, name: string): Promise<string> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    const normalizedName = workspaceEntryName(name);
    assertEditableWorkspacePath(entryPath);
    return this.#mutateWorkspace(id, async () => {
      const source = await resolveWorkspaceEntry(project.workspacePath, entryPath);
      assertEditableWorkspacePath(source.relativePath);
      const renamedPath = path.posix.join(path.posix.dirname(source.relativePath), normalizedName);
      assertEditableWorkspacePath(renamedPath);
      const destination = path.join(path.dirname(source.absolutePath), normalizedName);
      if (source.absolutePath === destination) return source.relativePath;
      try {
        await lstat(destination);
        throw new ProjectAssetError("A file or folder with that name already exists", 409);
      } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      await rename(source.absolutePath, destination);
      try {
        await renameCanvasAssetPaths(project.workspacePath, source.relativePath, renamedPath);
        await this.#writeAssetMetadata(id, () => renameAssetMetadata(project.workspacePath, source.relativePath, renamedPath));
      } catch (cause) {
        await rename(destination, source.absolutePath);
        await renameCanvasAssetPaths(project.workspacePath, renamedPath, source.relativePath);
        throw cause;
      }
      await this.touch(id);
      return renamedPath;
    });
  }

  async deleteWorkspaceEntry(id: string, entryPath: string): Promise<void> {
    const project = this.#projects.get(id);
    if (!project) throw new ProjectAssetError("Project not found", 404);
    assertEditableWorkspacePath(entryPath);
    await this.#mutateWorkspace(id, async () => {
      const source = await resolveWorkspaceEntry(project.workspacePath, entryPath);
      assertEditableWorkspacePath(source.relativePath);
      const manifest = await readCanvasAssets(project.workspacePath);
      const canvasIds = Object.entries(manifest.assets).filter(([, asset]) => asset.path === source.relativePath || asset.path.startsWith(`${source.relativePath}/`)).map(([assetId]) => assetId);
      const removed = `${source.absolutePath}.${randomUUID()}.removed`;
      await rename(source.absolutePath, removed);
      let previewPaths: string[];
      try {
        await removeCanvasAssetReferences(project.workspacePath, canvasIds, { localOnly: true });
        previewPaths = await this.#writeAssetMetadata(id, () => deleteAssetMetadata(project.workspacePath, source.relativePath));
      } catch (cause) {
        await rename(removed, source.absolutePath);
        throw cause;
      }
      await rm(removed, { recursive: true, force: true });
      if (previewPaths.length) {
        await ensureDirectory(path.join(project.workspacePath, ".data"));
        await ensureDirectory(path.join(project.workspacePath, ".data", "asset-previews"));
        for (const preview of previewPaths) await rm(path.join(project.workspacePath, ...preview.split("/")), { force: true });
      }
      await this.touch(id);
    });
  }

  async #writeAssetMetadata<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#serialize(id, this.#assetMetadataWrites, operation);
  }

  async #mutateWorkspace<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.#serialize(id, this.#workspaceWrites, operation);
  }

  async #serialize<T>(id: string, writes: Map<string, Promise<unknown>>, operation: () => Promise<T>): Promise<T> {
    const write = (writes.get(id)?.catch(() => {}) ?? Promise.resolve()).then(operation);
    writes.set(id, write);
    try {
      return await write;
    } finally {
      if (writes.get(id) === write) writes.delete(id);
    }
  }

  async libraryAssetAssociations(onError: (project: ProjectState, cause: unknown) => void): Promise<Map<string, { projects: LibraryAssetProject[]; hasAssetUsage: boolean }>> {
    const associations = new Map<string, { projects: LibraryAssetProject[]; hasAssetUsage: boolean }>();
    for (const project of this.#projects.values()) {
      if (project.workspaceAvailable === false) continue;
      const metadata = await readAssetMetadata(project.workspacePath);
      const usage = new Map<string, boolean>(Object.values(metadata.libraryAssets).map((id) => [id, false]));
      try {
        for (const [id, asAsset] of await canvasLibraryAssetUsage(project.workspacePath)) usage.set(id, asAsset);
      } catch (cause) { onError(project, cause); }
      if (project.type === "interactive-story" && await exists(path.join(project.workspacePath, PLAYABLE_GRAPH_FILE))) {
        try {
          const graph = await readNodeGraphForReferences(project.workspacePath);
          for (const asset of Object.values(graph.assets)) {
            if (asset.source.kind === "library") usage.set(asset.source.assetId, true);
          }
        } catch (cause) { onError(project, cause); }
      }
      for (const [id, asAsset] of usage) {
        const association = associations.get(id) ?? { projects: [], hasAssetUsage: false };
        association.projects.push({ id: project.id, name: project.name, type: project.type });
        association.hasAssetUsage ||= asAsset;
        associations.set(id, association);
      }
    }
    return associations;
  }

  async referencesLibraryAsset(assetId: string): Promise<ProjectState[]> {
    const references: ProjectState[] = [];
    for (const project of this.#projects.values()) {
      if (project.workspaceAvailable === false) continue;
      const metadata = await readAssetMetadata(project.workspacePath);
      let referenced = Object.values(metadata.libraryAssets).includes(assetId);
      try {
        referenced ||= await canvasReferencesAsset(project.workspacePath, assetId);
      } catch (cause) {
        throw new ProjectLibraryReferenceError(`Cannot verify canvas references in ${project.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (project.type === "interactive-story" && await exists(path.join(project.workspacePath, PLAYABLE_GRAPH_FILE))) {
        try {
          const graph = await readNodeGraphForReferences(project.workspacePath);
          referenced ||= Object.values(graph.assets).some((asset) => (
            asset.source.kind === "library" && asset.source.assetId === assetId
          ));
        } catch (cause) {
          throw new ProjectLibraryReferenceError(`Cannot verify Library references in ${project.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (referenced) {
        references.push(project);
        continue;
      }
    }
    return references;
  }

  async removeLibraryAssetReferences(assetId: string): Promise<void> {
    for (const project of await this.referencesLibraryAsset(assetId)) {
      await removeCanvasAssetReferences(project.workspacePath, assetId);
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
      if (project.type === "interactive-story" && await exists(path.join(project.workspacePath, PLAYABLE_GRAPH_FILE))) {
        const graph = await readNodeGraphForReferences(project.workspacePath);
        const removedIds = new Set(Object.entries(graph.assets).flatMap(([id, asset]) => (
          asset.source.kind === "library" && asset.source.assetId === assetId ? [id] : []
        )));
        if (removedIds.size > 0) {
          const codebase = await readNodeCodebase(project.workspacePath);
          for (const id of removedIds) delete codebase.graph.assets[id];
          codebase.graph.nodes = codebase.graph.nodes.map((node) => ({
            ...node,
            assets: node.assets.filter((id) => !removedIds.has(id)),
          }));
          await writeNodeCodebase(project.workspacePath, codebase);
          await this.touch(project.id);
        }
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
    changes: Partial<Pick<ProjectMetadata, "name" | "updatedAt" | "webPreviewEnabled" | "startupDirectory" | "startupScript" | "packageManager" | "previewPath" | "previewViewport" | "publication" | "mediaModelDefaults">>,
  ): Promise<void> {
    const operation = (this.#metadataWrites.get(project.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const metadata = { ...metadataFor(project), ...changes };
      await writeMetadata(this.#projectDirectory(project.id), metadata);
      project.name = metadata.name;
      project.updatedAt = metadata.updatedAt;
      if (project.type === "general") project.webPreviewEnabled = metadata.webPreviewEnabled ?? false;
      if (metadata.startupDirectory) project.startupDirectory = metadata.startupDirectory;
      else delete project.startupDirectory;
      if (metadata.startupScript) project.startupScript = metadata.startupScript;
      else delete project.startupScript;
      if (metadata.packageManager) project.packageManager = metadata.packageManager;
      else delete project.packageManager;
      if (metadata.previewPath) project.previewPath = metadata.previewPath;
      else delete project.previewPath;
      if (metadata.previewViewport) project.previewViewport = metadata.previewViewport;
      else delete project.previewViewport;
      if (metadata.mediaModelDefaults) project.mediaModelDefaults = metadata.mediaModelDefaults;
      else delete project.mediaModelDefaults;
      if (metadata.publication) project.publication = metadata.publication;
      else delete project.publication;
    });
    this.#metadataWrites.set(project.id, operation);
    try { await operation; }
    finally { if (this.#metadataWrites.get(project.id) === operation) this.#metadataWrites.delete(project.id); }
  }

  async #validateExternalWorkspace(selectedWorkspacePath: string): Promise<string> {
    if (!path.isAbsolute(selectedWorkspacePath)) throw new ProjectWorkspaceError("Workspace path must be absolute");
    let entry: Awaited<ReturnType<typeof lstat>>;
    let workspacePath: string;
    try {
      entry = await lstat(selectedWorkspacePath);
      workspacePath = await realpath(selectedWorkspacePath);
    } catch {
      throw new ProjectWorkspaceError("Selected workspace folder is not available");
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new ProjectWorkspaceError("Selected workspace must be a directory, not a symbolic link");
    }
    if (path.parse(workspacePath).root === workspacePath) {
      throw new ProjectWorkspaceError("The filesystem root cannot be used as a workspace");
    }
    if (pathsOverlap(workspacePath, this.#projectsDirectory)) {
      throw new ProjectWorkspaceError("OhMyGame's project storage cannot be used as a workspace");
    }
    for (const project of this.#projects.values()) {
      const existingWorkspace = path.resolve(project.workspacePath);
      if (pathsOverlap(workspacePath, existingWorkspace)) {
        throw new ProjectWorkspaceError("This folder overlaps with another OhMyGame workspace");
      }
    }
    return workspacePath;
  }

  #projectDirectory(id: string): string {
    return path.join(this.#projectsDirectory, id);
  }

}

function projectState(
  workspacePath: string,
  metadata: ProjectMetadata,
  runnable: boolean,
  storagePath: string,
  workspaceAvailable: boolean,
): ProjectState {
  return {
    id: metadata.id,
    name: metadata.name,
    type: metadata.type,
    ...(metadata.type === "general" ? { webPreviewEnabled: metadata.webPreviewEnabled ?? false } : {}),
    updatedAt: metadata.updatedAt,
    workspacePath,
    ...(metadata.startupDirectory ? { startupDirectory: metadata.startupDirectory } : {}),
    ...(metadata.startupScript ? { startupScript: metadata.startupScript } : {}),
    ...(metadata.packageManager ? { packageManager: metadata.packageManager } : {}),
    ...(metadata.previewPath ? { previewPath: metadata.previewPath } : {}),
    ...(metadata.previewViewport ? { previewViewport: metadata.previewViewport } : {}),
    ...(metadata.mediaModelDefaults ? { mediaModelDefaults: metadata.mediaModelDefaults } : {}),
    storagePath,
    workspaceLocation: metadata.workspacePath ? "external" : "managed",
    workspaceAvailable,
    preview: { status: runnable ? "stopped" : "waiting" },
    ...(metadata.publication ? { publication: metadata.publication } : {}),
  };
}

async function isRunnableStartupWorkspace(project: Pick<ProjectState, "type" | "webPreviewEnabled" | "workspacePath" | "startupDirectory" | "startupScript">): Promise<boolean> {
  if (project.type === "general" && !supportsWebPreview(project)) return false;
  try {
    return (await resolvePreviewWorkspace(project)).runnable;
  } catch {
    return false;
  }
}

export interface PreviewWorkspaceStatus {
  runnable: boolean;
  error?: string;
}

/** Resolve the configured directory and inspect its preview script in one place. */
export async function resolvePreviewWorkspace(project: Pick<ProjectState, "workspacePath" | "startupDirectory" | "startupScript">): Promise<PreviewWorkspaceStatus & { absolutePath: string; relativePath: string }> {
  const directory = await resolveStartupDirectory(project.workspacePath, project.startupDirectory ?? ".");
  return { ...directory, ...await previewWorkspaceStatus(directory.absolutePath, project.startupScript ?? "dev") };
}

export async function previewWorkspaceStatus(workspacePath: string, startupScript = "dev"): Promise<PreviewWorkspaceStatus> {
  const script = normalizeStartupScript(startupScript) ?? "dev";
  const label = script === "dev" ? "dev script" : `${script} script`;
  try {
    const packageJson = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const command = packageJson.scripts?.[script];
    if (typeof command !== "string" || !command.trim()) {
      return { runnable: false, error: `This folder has no ${label} that starts a preview server.` };
    }
    if (isNonServerDevCommand(command)) {
      return {
        runnable: false,
        error: `This folder's ${label} runs a non-server task: ${command.trim()}`,
      };
    }
    return { runnable: true };
  } catch {
    return { runnable: false, error: `This folder has no package.json ${label} that starts a preview server.` };
  }
}

function isNonServerDevCommand(command: string): boolean {
  return /(?:^|[\s/])(?:build|check|eslint|fmt|format|lint|prettier|test|typecheck)(?:$|[\s./:])/.test(command.toLowerCase());
}

export async function resolveStartupDirectory(workspacePath: string, input: string): Promise<{ absolutePath: string; relativePath: string }> {
  if (!isValidStartupDirectory(input)) {
    throw new ProjectWorkspaceError("Startup directory must be a relative path inside the project workspace");
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(workspacePath);
  } catch {
    throw new ProjectWorkspaceError("The project workspace is not available");
  }
  const configured = normalizeStartupDirectory(input) ?? ".";
  const candidate = path.resolve(workspaceRoot, configured);
  if (!pathContains(workspaceRoot, candidate)) {
    throw new ProjectWorkspaceError("Startup directory must be inside the project workspace");
  }
  let absolutePath: string;
  try {
    absolutePath = await realpath(candidate);
  } catch {
    throw new ProjectWorkspaceError("Startup directory does not exist");
  }
  if (!pathContains(workspaceRoot, absolutePath)) {
    throw new ProjectWorkspaceError("Startup directory must be inside the project workspace");
  }
  if (!(await lstat(absolutePath)).isDirectory()) {
    throw new ProjectWorkspaceError("Startup directory must be a folder");
  }
  const relativePath = path.relative(workspaceRoot, absolutePath).replaceAll(path.sep, "/");
  return { absolutePath, relativePath: relativePath || "." };
}

function isValidStartupDirectory(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "." || normalizeStartupDirectory(trimmed) !== undefined;
}

function normalizeStartupDirectory(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized === ".") return undefined;
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return undefined;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined;
  return parts.join("/");
}

function normalizeStartupScript(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(normalized) ? normalized : undefined;
}

function normalizePreviewPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("\\", "/");
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) return undefined;
  return `/${normalized.replace(/^\/+/, "")}`;
}

function isPreviewViewport(value: unknown): value is PreviewViewport {
  return value === "fit" || value === "tablet" || value === "mobile";
}

function projectRunSettings(project: ProjectState): ProjectRunSettings {
  return {
    ...(project.type === "general" ? { webPreviewEnabled: project.webPreviewEnabled ?? false } : {}),
    startupDirectory: project.startupDirectory ?? ".",
    startupScript: project.startupScript ?? "dev",
    ...(project.packageManager ? { packageManager: project.packageManager } : {}),
    previewPath: project.previewPath ?? "/",
    previewViewport: project.previewViewport ?? "fit",
  };
}

async function readMetadata(projectDirectory: string, id: string, fallbackUpdatedAt: string): Promise<LoadedMetadata> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8")) as Partial<ProjectMetadata>;
    if (
      parsed.version === 1 && parsed.id === id && typeof parsed.name === "string" && parsed.name.trim() &&
      (parsed.type === undefined || isProjectType(parsed.type)) &&
      (parsed.webPreviewEnabled === undefined || typeof parsed.webPreviewEnabled === "boolean") &&
      (parsed.startupDirectory === undefined || isValidStartupDirectory(parsed.startupDirectory)) &&
      (parsed.startupScript === undefined || normalizeStartupScript(parsed.startupScript) !== undefined) &&
      (parsed.packageManager === undefined || isProjectPackageManager(parsed.packageManager)) &&
      (parsed.previewPath === undefined || normalizePreviewPath(parsed.previewPath) !== undefined) &&
      (parsed.previewViewport === undefined || isPreviewViewport(parsed.previewViewport)) &&
      (parsed.workspacePath === undefined || (typeof parsed.workspacePath === "string" && path.isAbsolute(parsed.workspacePath))) &&
      (parsed.mediaModelDefaults === undefined || validMediaModelDefaults(parsed.mediaModelDefaults)) &&
      (parsed.publication === undefined || validPublication(parsed.publication))
    ) {
      const updatedAt = typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : fallbackUpdatedAt;
      const type = parsed.type ?? "web-game";
      const startupDirectory = normalizeStartupDirectory(parsed.startupDirectory);
      const startupScript = normalizeStartupScript(parsed.startupScript);
      const packageManager = parsed.packageManager;
      const previewPath = normalizePreviewPath(parsed.previewPath);
      const previewViewport = parsed.previewViewport;
      const workspacePath = parsed.workspacePath;
      return {
        metadata: {
          version: 1,
          id,
          name: parsed.name.trim(),
          type,
          ...(type === "general" ? { webPreviewEnabled: parsed.webPreviewEnabled ?? false } : {}),
          updatedAt,
          ...(startupDirectory ? { startupDirectory } : {}),
          ...(startupScript && startupScript !== "dev" ? { startupScript } : {}),
          ...(packageManager ? { packageManager } : {}),
          ...(previewPath && previewPath !== "/" ? { previewPath } : {}),
          ...(previewViewport && previewViewport !== "fit" ? { previewViewport } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          ...(parsed.publication ? { publication: parsed.publication } : {}),
          ...(parsed.mediaModelDefaults ? { mediaModelDefaults: parsed.mediaModelDefaults } : {}),
        },
        missing: parsed.updatedAt !== updatedAt || parsed.type !== type || parsed.startupDirectory !== startupDirectory ||
          parsed.startupScript !== startupScript || parsed.packageManager !== packageManager ||
          parsed.previewPath !== previewPath || parsed.previewViewport !== previewViewport || parsed.workspacePath !== workspacePath,
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
    ...(project.type === "general" ? { webPreviewEnabled: project.webPreviewEnabled ?? false } : {}),
    updatedAt: project.updatedAt,
    ...(project.startupDirectory ? { startupDirectory: project.startupDirectory } : {}),
    ...(project.startupScript ? { startupScript: project.startupScript } : {}),
    ...(project.packageManager ? { packageManager: project.packageManager } : {}),
    ...(project.previewPath ? { previewPath: project.previewPath } : {}),
    ...(project.previewViewport ? { previewViewport: project.previewViewport } : {}),
    ...(project.mediaModelDefaults ? { mediaModelDefaults: project.mediaModelDefaults } : {}),
    ...(project.workspaceLocation === "external" ? { workspacePath: project.workspacePath } : {}),
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

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readNodeGraphForReferences(workspacePath: string): Promise<NodeGraph> {
  const file = path.join(workspacePath, PLAYABLE_GRAPH_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error("graph.json is not valid JSON.");
    throw cause;
  }
  const validation = validateNodeGraph(value, { mode: "draft" });
  if (!validation.ok) {
    const issue = validation.issues[0]!;
    throw new Error(`${issue.path}: ${issue.message}`);
  }
  return value as NodeGraph;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await transform(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function validPublication(value: unknown): value is PublicationState {
  if (!value || typeof value !== "object") return false;
  const publication = value as Partial<PublicationState>;
  return typeof publication.gameId === "string" && typeof publication.deploymentId === "string" &&
    typeof publication.playUrl === "string" && typeof publication.publishedAt === "string" &&
    (publication.title === undefined || typeof publication.title === "string") &&
    (publication.description === undefined || typeof publication.description === "string");
}

function validMediaModelDefaults(value: unknown): value is MediaModelDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([usage, ref]) => ["image", "video", "3d"].includes(usage)
    && ref && typeof ref === "object" && !Array.isArray(ref)
    && Object.keys(ref).every((key) => key === "provider" || key === "id")
    && typeof ref.provider === "string" && ref.provider.trim().length > 0 && ref.provider.length <= 100
    && typeof ref.id === "string" && ref.id.trim().length > 0 && ref.id.length <= 200);
}
