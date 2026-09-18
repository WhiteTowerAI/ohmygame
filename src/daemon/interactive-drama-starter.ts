import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { INTERACTIVE_DRAMA_STARTER, createInteractiveDramaStarterStory } from "../shared/interactive-drama-starter.js";
import type { ProjectState } from "../shared/contracts.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";

interface StoredStarterState {
  version: 1;
  provided: true;
}

export class InteractiveDramaStarter {
  readonly #filePath: string;
  #initialization?: Promise<void>;

  constructor(
    dataDirectory: string,
    private readonly examplesDirectory: string,
    private readonly projects: ProjectManager,
    private readonly library: AssetLibrary,
  ) {
    this.#filePath = path.join(dataDirectory, "interactive-drama-state.json");
  }

  ensure(): Promise<void> {
    if (this.#initialization) return this.#initialization;
    const initialization = this.#ensure().catch((error) => {
      if (this.#initialization === initialization) this.#initialization = undefined;
      throw error;
    });
    this.#initialization = initialization;
    return initialization;
  }

  /** Create a new Interactive Drama directly from the bundled starter template. */
  createProject(name?: string, workspacePath?: string): Promise<ProjectState> {
    return createStarterProject(this.examplesDirectory, this.projects, this.library, name, workspacePath);
  }

  async #ensure(): Promise<void> {
    if (await this.#wasProvided()) return;
    if (!this.projects.list().some((project) => project.type === "interactive-drama")) {
      await createStarterProject(this.examplesDirectory, this.projects, this.library);
    }
    await this.#markProvided();
  }

  async #wasProvided(): Promise<boolean> {
    try {
      const value: unknown = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (!isStoredStarterState(value)) throw new Error(`Invalid Interactive Drama state: ${this.#filePath}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #markProvided(): Promise<void> {
    const state: StoredStarterState = { version: 1, provided: true };
    await mkdir(path.dirname(this.#filePath), { recursive: true });
    const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.#filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function createStarterProject(
  examplesDirectory: string,
  projects: ProjectManager,
  library: AssetLibrary,
  name?: string,
  workspacePath?: string,
): Promise<ProjectState> {
  const directory = path.join(examplesDirectory, INTERACTIVE_DRAMA_STARTER.id);
  const project = await projects.create(name?.trim() || INTERACTIVE_DRAMA_STARTER.name, "interactive-drama", workspacePath);
  try {
    const video = await library.addFile("night-train.mp4", path.join(directory, "night-train.mp4"), {
      sourceKey: `builtin:interactive-drama:${INTERACTIVE_DRAMA_STARTER.id}:video:v1`,
      duration: 12,
    });
    await projects.setStory(project.id, createInteractiveDramaStarterStory({ videoId: video.id }, project.name));
    await projects.setCover(project.id, await readFile(path.join(directory, "mara.jpg")));
    return projects.get(project.id)!;
  } catch (error) {
    await projects.delete(project.id);
    throw error;
  }
}

function isStoredStarterState(value: unknown): value is StoredStarterState {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Partial<StoredStarterState>).version === 1 && (value as Partial<StoredStarterState>).provided === true &&
    Object.keys(value).every((key) => key === "version" || key === "provided"));
}
