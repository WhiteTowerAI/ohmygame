import type { ProjectType } from "./contracts.js";

export function defaultProjectName(type: ProjectType): string {
  return type === "interactive-drama" ? "Untitled drama" : "Untitled project";
}
