import type { ProjectType } from "./contracts.js";

export function defaultProjectName(type: ProjectType): string {
  if (type === "interactive-story") return "Untitled story";
  if (type === "asset-canvas") return "Untitled asset canvas";
  return "Untitled project";
}
