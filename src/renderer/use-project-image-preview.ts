import { useCallback } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { getProjectCover, getProjectLogo } from "./api.js";
import { ImagePreviews, useImagePreview } from "./image-preview.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

// The sidebar and project card can use the same image at the same time.
const images = new ImagePreviews();

export function useProjectImagePreview(project: ProjectState, kind: "cover" | "logo" | undefined) {
  const { id, updatedAt } = project;
  const runtime = useReadyRuntimeGeneration();
  const load = useCallback(() => kind === "logo" ? getProjectLogo(id) : getProjectCover(id), [id, kind]);
  // The project timestamp requests a check. The image's bytes decide whether to change the URL.
  return useImagePreview(kind ? JSON.stringify([id, kind]) : undefined, `${runtime}:${updatedAt}`, load, images);
}
