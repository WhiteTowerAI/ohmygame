import { randomUUID } from "node:crypto";
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState, ProjectType, PublicationState } from "../shared/contracts.js";

interface ProjectMetadata {
  version: 1;
  id: string;
  name: string;
  type: ProjectType;
  updatedAt: string;
  publication?: PublicationState;
}

interface LoadedMetadata {
  metadata: ProjectMetadata;
  missing: boolean;
}

const PROJECT_COVER_FILE = "cover.webp";

export class ProjectManager {
  readonly #projects = new Map<string, ProjectState>();
  readonly #projectsDirectory: string;

  constructor(dataDirectory: string) {
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

  async create(name?: string, type: ProjectType = "general"): Promise<ProjectState> {
    const id = randomUUID();
    const projectDirectory = path.join(this.#projectsDirectory, id);
    const workspacePath = path.join(projectDirectory, "workspace");
    const metadata: ProjectMetadata = {
      version: 1,
      id,
      name: name?.trim() || "Untitled project",
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

  async rename(id: string, name: string): Promise<ProjectState> {
    const project = this.#projects.get(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const normalized = name.trim();
    if (!normalized) throw new Error("Project name must not be empty");
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

  async addGeneratedAsset(id: string, fileName: string, contents: Uint8Array): Promise<string> {
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
    await this.touch(id);
    return relativePath.split(path.sep).join("/");
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
      (parsed.type === undefined || parsed.type === "general" || parsed.type === "interactive-drama") &&
      (parsed.publication === undefined || validPublication(parsed.publication))
    ) {
      const updatedAt = typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : fallbackUpdatedAt;
      const type = parsed.type ?? "general";
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
    return { metadata: { version: 1, id, name: "Untitled project", type: "general", updatedAt: fallbackUpdatedAt }, missing: true };
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

function validPublication(value: unknown): value is PublicationState {
  if (!value || typeof value !== "object") return false;
  const publication = value as Partial<PublicationState>;
  return typeof publication.gameId === "string" && typeof publication.deploymentId === "string" &&
    typeof publication.playUrl === "string" && typeof publication.publishedAt === "string";
}
