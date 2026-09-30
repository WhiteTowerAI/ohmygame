import { readFile } from "node:fs/promises";
import path from "node:path";
import { INTERACTIVE_DRAMA_STARTER } from "../shared/interactive-drama-starter.js";
import type { ProjectState } from "../shared/contracts.js";
import type { ProjectManager } from "./projects.js";
import { createNodeCodebase, createPlayableStarterCodebase } from "./playable-codebase.js";

export async function createInteractiveDramaStarterProject(
  examplesDirectory: string,
  projects: ProjectManager,
  name?: string,
  workspacePath?: string,
): Promise<ProjectState> {
  const directory = path.join(examplesDirectory, INTERACTIVE_DRAMA_STARTER.id);
  const cover = await readFile(path.join(directory, "mara.jpg"));
  const project = await projects.create(name?.trim() || INTERACTIVE_DRAMA_STARTER.name, "interactive-drama", workspacePath);
  try {
    await createNodeCodebase(project.workspacePath, createPlayableStarterCodebase(project.name, { width: 1280, height: 720 }, "night-train"));
    await projects.setCover(project.id, cover);
    return projects.get(project.id)!;
  } catch (error) {
    await projects.delete(project.id);
    throw error;
  }
}
