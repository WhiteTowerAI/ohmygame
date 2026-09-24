import type { ProjectType } from "./contracts.js";

export function defaultProjectName(type: ProjectType): string {
  if (type === "interactive-drama") return "Untitled drama";
  if (type === "asset-canvas") return "Untitled asset canvas";
  return "Untitled project";
}
