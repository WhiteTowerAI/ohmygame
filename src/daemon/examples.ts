import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { isPreparedExampleCatalog, type ExampleSummary, type PreparedExample } from "../shared/examples.js";
import { ProjectWorkspaceError, type ProjectManager } from "./projects.js";

export class ExampleError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404) {
    super(message);
  }
}

// Files a desktop OS leaves in folders; a folder holding only these counts as empty.
const IGNORABLE_WORKSPACE_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Example projects packaged by scripts/prepare-examples.ts. A missing or
 * invalid catalog leaves the store empty so the app still works without them.
 */
export class ExampleStore {
  readonly #directory: string | undefined;
  #examples: PreparedExample[] = [];

  constructor(directory: string | undefined) {
    this.#directory = directory;
  }

  async load(): Promise<string | undefined> {
    this.#examples = [];
    if (!this.#directory) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(this.#directory, "catalog.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return `Examples catalog could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!isPreparedExampleCatalog(parsed)) return "Examples catalog is invalid";
    this.#examples = parsed.examples;
    return undefined;
  }

  list(): ExampleSummary[] {
    return this.#examples.map(({ id, type, name, description }) => ({ id, type, name, description }));
  }

  async cover(id: string): Promise<Buffer | undefined> {
    const example = this.#example(id);
    if (!example) return undefined;
    return readFile(path.join(this.#directory!, example.cover));
  }

  /** Creates a project whose workspace starts as a copy of the example. */
  async createProject(
    projects: ProjectManager,
    id: string,
    options: { type?: ProjectType; name?: string; workspacePath?: string } = {},
  ): Promise<ProjectState> {
    const example = this.#example(id);
    if (!example) throw new ExampleError(`Example not found: ${id}`, 404);
    if (options.type && options.type !== example.type) {
      throw new ExampleError("The example does not match the project type", 400);
    }
    // Never mix example files into a folder that already holds work: a failed
    // copy could not be cleaned up without touching the user's files.
    if (options.workspacePath && !(await isEmptyDirectory(options.workspacePath))) {
      throw new ProjectWorkspaceError("Choose an empty folder to start from an example");
    }
    const project = await projects.create(options.name?.trim() || example.name, example.type, options.workspacePath);
    try {
      // Copy entry by entry: the workspace folder itself already exists, and
      // fs.cp treats that as a conflict when overwriting is disabled.
      const source = path.join(this.#directory!, example.directory);
      for (const entry of await readdir(source)) {
        await cp(path.join(source, entry), path.join(project.workspacePath, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      await projects.setCover(project.id, await readFile(path.join(this.#directory!, example.cover)));
      return await projects.refreshPreviewReadiness(project.id);
    } catch (error) {
      await projects.delete(project.id);
      throw error;
    }
  }

  #example(id: string): PreparedExample | undefined {
    return this.#examples.find((example) => example.id === id);
  }
}

async function isEmptyDirectory(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).every((entry) => IGNORABLE_WORKSPACE_FILES.has(entry));
  } catch {
    // Let project creation report a missing or unreadable folder.
    return true;
  }
}
