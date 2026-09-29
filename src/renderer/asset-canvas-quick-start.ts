import type { ProjectState } from "../shared/contracts.js";
import { createAssetCanvasStarterDocument, type AssetCanvasStarter } from "../shared/asset-canvas.js";
import { createProject, deleteProject, listImageModels, updateAssetCanvas } from "./api.js";

export async function createAssetCanvasQuickStart(type: AssetCanvasStarter): Promise<{ project: ProjectState; nodeId: string }> {
  const imageModel = type === "image"
    ? (await listImageModels()).find((model) => model.id === "gpt-image-2.5-flare" || model.id.endsWith("/gpt-image-2.5-flare"))
    : undefined;
  if (type === "image" && !imageModel) throw new Error("GPT Image 2.5 is not available");

  const { document, nodeId } = createAssetCanvasStarterDocument(
    type,
    imageModel ? { provider: imageModel.provider, id: imageModel.id } : undefined,
  );
  const project = await createProject({ type: "asset-canvas" });
  try {
    await updateAssetCanvas(project.id, document);
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
