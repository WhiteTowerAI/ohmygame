import { readFile } from "node:fs/promises";
import path from "node:path";
import { INTERACTIVE_DRAMA_STARTER, createInteractiveDramaStarterStory } from "../shared/interactive-drama-starter.js";
import type { ProjectState } from "../shared/contracts.js";
import type { ProjectManager } from "./projects.js";

export async function createInteractiveDramaStarterProject(
  examplesDirectory: string,
  projects: ProjectManager,
  name?: string,
  workspacePath?: string,
): Promise<ProjectState> {
  const directory = path.join(examplesDirectory, INTERACTIVE_DRAMA_STARTER.id);
  const project = await projects.create(name?.trim() || INTERACTIVE_DRAMA_STARTER.name, "interactive-drama", workspacePath);
  try {
    await projects.setStory(project.id, createInteractiveDramaStarterStory(project.name));
    await projects.setCover(project.id, await readFile(path.join(directory, "mara.jpg")));
    return projects.get(project.id)!;
  } catch (error) {
    await projects.delete(project.id);
    throw error;
  }
}
