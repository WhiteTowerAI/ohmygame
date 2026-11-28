import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ProjectState, ProjectType, ToolJob } from "../shared/contracts.js";
import { EXAMPLE_DOWNLOAD_UNAVAILABLE, isPreparedExampleCatalog, type ExampleArchiveKind, type ExampleSummary, type PreparedExample, type PreparedExampleCatalog } from "../shared/examples.js";
import { PROJECT_FILE_NAME } from "../shared/project-file.js";
import { LoopbackFileServer } from "./loopback-file-server.js";
import { ProjectWorkspaceError, type ProjectManager } from "./projects.js";
import { readCanvasFile, writeCanvasJson } from "./canvas-files.js";
import { ExampleDownloads, hasExampleEntrypoint } from "./example-downloads.js";

export class ExampleError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 502, readonly code?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

// Files a desktop OS leaves in folders; a folder holding only these counts as empty.
const IGNORABLE_WORKSPACE_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * The catalog and covers ship with the app. Only Play and Remix need project files.
 */
export class ExampleStore {
  readonly #downloads: ExampleDownloads;
  readonly #playServer = new LoopbackFileServer();
  readonly #playUrls = new Map<string, Promise<string>>();
  #catalog?: PreparedExampleCatalog;
  #cacheCleanup?: Promise<void>;

  constructor(
    private readonly directory: string | undefined,
    dataDirectory: string,
    private readonly preparedDirectory?: string,
  ) {
    this.#downloads = new ExampleDownloads(path.join(dataDirectory, "examples-cache-v1"));
  }

  async load(warn: (message: string) => void): Promise<void> {
    this.#catalog = undefined;
    if (!this.directory) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(this.directory, "catalog.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      return warn(`Examples catalog could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isPreparedExampleCatalog(parsed)) return warn("Examples catalog is invalid");
    this.#catalog = parsed;
    if (parsed.version === 2) {
      this.#cacheCleanup = this.#downloads.removeOtherRevisions(parsed.source.commit)
        .catch((error: unknown) => warn(`Could not clean older example downloads: ${String(error)}`));
    }
  }

  list(): ExampleSummary[] {
    return this.#catalog?.examples.map(({ id, type, name, description }) => ({ id, type, name, description })) ?? [];
  }

  async cover(id: string): Promise<Buffer | undefined> {
    const example = this.#example(id);
    if (!example) return undefined;
    return readFile(path.join(this.directory!, example.cover));
  }

  /** Returns a loopback URL that plays the example, built once per run. */
  async playUrl(id: string): Promise<string> {
    const example = this.#example(id);
    if (!example) throw new ExampleError(`Example not found: ${id}`, 404);
    let url = this.#playUrls.get(id);
    if (!url) {
      url = this.#payloadDirectory(example, example.play ? "play" : "files").then((directory) => this.#playServer.mount(directory)).then((mount) => mount.url);
      this.#playUrls.set(id, url);
      url.catch(() => this.#playUrls.delete(id));
    }
    return url;
  }

  stopDownloads(): void {
    this.#downloads.stop();
  }

  async close(): Promise<void> {
    await Promise.all([this.#downloads.close(), this.#cacheCleanup]);
    await Promise.allSettled(this.#playUrls.values());
    this.#playUrls.clear();
    await this.#playServer.close();
  }

  async #payloadDirectory(example: PreparedExample, kind: ExampleArchiveKind): Promise<string> {
    const relative = kind === "play" ? example.play! : example.directory;
    // Version 1 catalogs name projects already prepared on disk.
    if (this.#catalog!.version === 1) return path.join(this.directory!, relative);
    const commit = this.#catalog!.source.commit;
    const entrypoint = kind === "files" && example.play ? "package.json" : "index.html";
    try {
      const prepared = await this.#localPrepared(example.id, commit, kind, entrypoint);
      return prepared ?? await this.#downloads.get(commit, example.id, kind, entrypoint);
    } catch (cause) {
      throw new ExampleError("Could not download this example. Try again.", 502, EXAMPLE_DOWNLOAD_UNAVAILABLE, { cause });
    }
  }

  async #localPrepared(id: string, commit: string, kind: ExampleArchiveKind, entrypoint: string): Promise<string | undefined> {
    // Reuse an existing development download or explicit local preparation of
    // an unpublished pin. Remove the fallback with the version 1 reader.
    if (!this.preparedDirectory) return undefined;
    const catalog: unknown = await readFile(path.join(this.preparedDirectory, "catalog.json"), "utf8")
      .then((text): unknown => JSON.parse(text)).catch(() => undefined);
    if (!isPreparedExampleCatalog(catalog) || catalog.version !== 1
      || catalog.source.commit !== commit || catalog.source.repository !== this.#catalog!.source.repository) return undefined;
    const example = catalog.examples.find((item) => item.id === id);
    const relative = kind === "play" ? example?.play : example?.directory;
    if (!relative) return undefined;
    const directory = path.join(this.preparedDirectory, relative);
    if (await hasExampleEntrypoint(directory, entrypoint)) return directory;
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
    const requireEmptyWorkspace = async () => {
      if (options.workspacePath && !(await isEmptyDirectory(options.workspacePath))) {
        throw new ProjectWorkspaceError("Choose an empty folder to start from an example");
      }
    };
    await requireEmptyWorkspace();
    const source = await this.#payloadDirectory(example, "files");
    await requireEmptyWorkspace();
    const project = await projects.create(options.name?.trim() || example.name, example.type, options.workspacePath);
    try {
      // Copy entry by entry: the workspace folder itself already exists, and
      // fs.cp treats that as a conflict when overwriting is disabled.
      for (const entry of await readdir(source)) {
        // The project already names its type; an example's own file says it as the example wants.
        const named = entry === PROJECT_FILE_NAME;
        await cp(path.join(source, entry), path.join(project.workspacePath, entry), {
          recursive: true,
          force: named,
          errorOnExist: !named,
        });
      }
      // Keep copied boards and layouts verbatim. Historical jobs belong to the
      // new project; their node IDs, status, settings and outputs stay intact.
      // Retry inputs can contain inline images, exceeding the board-file limit.
      const history = await readCanvasFile(project.workspacePath, "jobs.json", Infinity);
      if (history !== undefined) {
        const jobs = JSON.parse(history) as ToolJob[];
        if (!Array.isArray(jobs)) throw new ExampleError("The example has invalid Canvas generation history", 400);
        await writeCanvasJson(project.workspacePath, "jobs.json", jobs.map((job) => ({
          ...job,
          context: { ...job.context, projectId: project.id },
        })));
      }
      await projects.setCover(project.id, await readFile(path.join(this.directory!, example.cover)), "auto");
      await projects.storeSettings(project.id);
      return await projects.refreshPreviewReadiness(project.id);
    } catch (error) {
      await projects.delete(project.id);
      throw error;
    }
  }

  #example(id: string): PreparedExample | undefined {
    return this.#catalog?.examples.find((example) => example.id === id);
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
