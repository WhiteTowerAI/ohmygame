import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { INTERACTIVE_DRAMA_STARTER, createInteractiveDramaStarterStory } from "../shared/interactive-drama-starter.js";
import type { ProjectState } from "../shared/contracts.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";

export async function createInteractiveDramaStarterProject(examplesDirectory: string, projects: ProjectManager, library: AssetLibrary, name?: string): Promise<ProjectState> {
  const directory = path.join(examplesDirectory, INTERACTIVE_DRAMA_STARTER.id);
  const videoContents = await readFile(path.join(directory, "night-train.mp4"));
  const videoHash = createHash("sha256").update(videoContents).digest("hex");
  const video = await library.add("night-train.mp4", videoContents, {
    sourceKey: `builtin:interactive-drama:${INTERACTIVE_DRAMA_STARTER.id}:video:${videoHash}`,
    duration: 12,
  });
  const project = await projects.create(name?.trim() || INTERACTIVE_DRAMA_STARTER.name, "interactive-drama");
  try {
    await projects.setStory(project.id, createInteractiveDramaStarterStory({ videoId: video.id }, project.name));
    await projects.setCover(project.id, await readFile(path.join(directory, "mara.jpg")));
    return projects.get(project.id)!;
  } catch (error) {
    await projects.delete(project.id);
    throw error;
  }
}
