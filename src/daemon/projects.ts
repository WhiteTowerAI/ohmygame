import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";

interface ProjectMetadata {
  version: 1;
  id: string;
  name: string;
}

interface LoadedMetadata {
  metadata: ProjectMetadata;
  missing: boolean;
}

export class ProjectManager {
  readonly #projects = new Map<string, ProjectState>();
  readonly #projectsDirectory: string;

  constructor(
    dataDirectory: string,
    private readonly templateDirectory: string,
  ) {
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
      const { metadata, missing } = await readMetadata(projectDirectory, entry.name);
      const project = projectState(workspacePath, metadata);
      this.#projects.set(project.id, project);
      if (missing) await writeMetadata(projectDirectory, metadata);
    }
  }

  async create(name?: string): Promise<ProjectState> {
    const id = randomUUID();
    const projectDirectory = path.join(this.#projectsDirectory, id);
    const workspacePath = path.join(projectDirectory, "workspace");
    const metadata: ProjectMetadata = {
      version: 1,
      id,
      name: name?.trim() || "Untitled project",
    };
    await mkdir(projectDirectory, { recursive: true });
    await cp(this.templateDirectory, workspacePath, { recursive: true });
    await writeMetadata(projectDirectory, metadata);
    const project = projectState(workspacePath, metadata);
    this.#projects.set(id, project);
    return project;
  }

  get(id: string): ProjectState | undefined { return this.#projects.get(id); }
}

function projectState(
  workspacePath: string,
  metadata: ProjectMetadata,
): ProjectState {
  return {
    id: metadata.id,
    name: metadata.name,
    workspacePath,
    preview: { status: "stopped" },
    agent: { status: "idle" },
  };
}

async function readMetadata(projectDirectory: string, id: string): Promise<LoadedMetadata> {
  try {
    const parsed = JSON.parse(await readFile(path.join(projectDirectory, "project.json"), "utf8")) as Partial<ProjectMetadata>;
    if (parsed.version === 1 && parsed.id === id && typeof parsed.name === "string" && parsed.name.trim()) {
      return { metadata: { version: 1, id, name: parsed.name.trim() }, missing: false };
    }
    throw new Error(`Invalid project metadata: ${path.join(projectDirectory, "project.json")}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { metadata: { version: 1, id, name: "Untitled project" }, missing: true };
  }
}

async function writeMetadata(projectDirectory: string, metadata: ProjectMetadata): Promise<void> {
  const destination = path.join(projectDirectory, "project.json");
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function isProjectId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
