import type { ProjectState } from "../shared/contracts.js";
import { createAssetCanvasStarterStory, type AssetCanvasStarter } from "../shared/story.js";
import { createProject, deleteProject, listImageModels, updateStory } from "./api.js";

export async function createAssetCanvasQuickStart(type: AssetCanvasStarter): Promise<{ project: ProjectState; nodeId: string }> {
  const imageModel = type === "image"
    ? (await listImageModels()).find((model) => model.id === "gpt-image-2.5-flare" || model.id.endsWith("/gpt-image-2.5-flare"))
    : undefined;
  if (type === "image" && !imageModel) throw new Error("GPT Image 2.5 is not available");

  const { story, nodeId } = createAssetCanvasStarterStory(
    type,
    imageModel ? { provider: imageModel.provider, id: imageModel.id } : undefined,
  );
  const project = await createProject({ type: "asset-canvas" });
  try {
    await updateStory(project.id, story);
  } catch (cause) {
    try {
      await deleteProject(project.id);
    } catch {
      throw new Error(`${errorMessage(cause)}. The empty canvas could not be removed.`);
    }
    throw cause;
  }
  return { project, nodeId };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
