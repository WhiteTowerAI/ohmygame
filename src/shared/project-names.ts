import type { ProjectState, ProjectType } from "./contracts.js";

export function defaultProjectName(type: ProjectType): string {
  return type === "interactive-drama" ? "Untitled drama" : "Untitled project";
}

export function isDefaultProjectName(project: Pick<ProjectState, "name" | "type">): boolean {
  return project.name === defaultProjectName(project.type);
}
