import { readFile } from "node:fs/promises";
import path from "node:path";
import { INTERACTIVE_DRAMA_EXAMPLE, INTERACTIVE_DRAMA_EXAMPLE_ID, createInteractiveDramaExampleStory } from "../shared/interactive-drama-examples.js";
import type { ProjectState } from "../shared/contracts.js";
import type { AssetLibrary } from "./asset-library.js";
import type { ProjectManager } from "./projects.js";

export async function createInteractiveDramaExample(
  examplesDirectory: string,
  projects: ProjectManager,
  library: AssetLibrary,
): Promise<ProjectState> {
  const directory = path.join(examplesDirectory, INTERACTIVE_DRAMA_EXAMPLE_ID);
  const [video, avatar] = await Promise.all([
    library.addFile("night-train.mp4", path.join(directory, "night-train.mp4"), {
      sourceKey: `builtin:interactive-drama:${INTERACTIVE_DRAMA_EXAMPLE_ID}:video:v1`,
      duration: 12,
    }),
    library.addFile("mara.jpg", path.join(directory, "mara.jpg"), {
      sourceKey: `builtin:interactive-drama:${INTERACTIVE_DRAMA_EXAMPLE_ID}:avatar:v1`,
    }),
  ]);
  const project = await projects.create(INTERACTIVE_DRAMA_EXAMPLE.name, "interactive-drama");
  try {
    await projects.setStory(project.id, createInteractiveDramaExampleStory({ videoId: video.id, avatarId: avatar.id }));
    await projects.setCover(project.id, await readFile(path.join(directory, "mara.jpg")));
    return projects.get(project.id)!;
  } catch (error) {
    await projects.delete(project.id);
    throw error;
  }
}
