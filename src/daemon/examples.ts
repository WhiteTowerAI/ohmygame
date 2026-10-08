import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { isPreparedExampleCatalog, type ExampleSummary, type PreparedExample } from "../shared/examples.js";
import { LoopbackFileServer } from "./loopback-file-server.js";
import { ensureNodeCodebaseContract } from "./playable-codebase.js";
import { ProjectWorkspaceError, type ProjectManager } from "./projects.js";

export class ExampleError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404) {
    super(message);
  }
}

/** Compiles an interactive story workspace into a Published Player directory. */
export type PreparePlayableExample = (workspacePath: string, exampleId: string) => Promise<string>;

// Files a desktop OS leaves in folders; a folder holding only these counts as empty.
const IGNORABLE_WORKSPACE_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Example projects packaged by scripts/prepare-examples.ts. A missing or
 * invalid catalog leaves the store empty so the app still works without them.
 */
export class ExampleStore {
  readonly #directory: string | undefined;
  readonly #playServer = new LoopbackFileServer();
  readonly #playUrls = new Map<string, Promise<string>>();
  readonly #temporaryDirectories: string[] = [];
  readonly #preparePlayable: PreparePlayableExample | undefined;
  #examples: PreparedExample[] = [];

  constructor(directory: string | undefined, preparePlayable?: PreparePlayableExample) {
    this.#directory = directory;
    this.#preparePlayable = preparePlayable;
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

  /** Returns a loopback URL that plays the example, built once per run. */
  async playUrl(id: string): Promise<string> {
    const example = this.#example(id);
    if (!example) throw new ExampleError(`Example not found: ${id}`, 404);
    let url = this.#playUrls.get(id);
    if (!url) {
      url = this.#playableDirectory(example).then((directory) => this.#playServer.mount(directory)).then((mount) => mount.url);
      this.#playUrls.set(id, url);
      url.catch(() => this.#playUrls.delete(id));
    }
    return url;
  }

  async close(): Promise<void> {
    this.#playUrls.clear();
    await this.#playServer.close();
    await Promise.all(this.#temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  }

  async #playableDirectory(example: PreparedExample): Promise<string> {
    if (example.play) return path.join(this.#directory!, example.play);
    if (!this.#preparePlayable) throw new Error(`${example.name} cannot be played in this build`);
    // Compile from a scratch copy: packaged examples live in read-only app resources.
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-example-"));
    this.#temporaryDirectories.push(workspace);
    await cp(path.join(this.#directory!, example.directory), workspace, { recursive: true });
    const player = await this.#preparePlayable(workspace, example.id);
    this.#temporaryDirectories.push(player);
    return player;
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
      // Agent instructions and schemas follow this app version, not the example.
      if (example.type === "interactive-story") await ensureNodeCodebaseContract(project.workspacePath);
      await projects.setCover(project.id, await readFile(path.join(this.#directory!, example.cover)), "auto");
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
