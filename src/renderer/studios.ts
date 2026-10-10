import type { ProjectState, ProjectType } from "../shared/contracts.js";

export type GameStudioType = Exclude<ProjectType, "asset-canvas">;

export const GAME_STUDIOS = {
  general: {
    page: "general",
    title: "What do you want to create?",
    placeholder: "Describe your game idea or what you want to build...",
    newLabel: "New game project",
  },
  "web-game": {
    page: "web-game",
    title: "What game are we making today?",
    placeholder: "Describe the browser game you want to create...",
    newLabel: "New game",
  },
  "interactive-story": {
    page: "interactive-story",
    title: "What story are we telling today?",
    placeholder: "Describe the interactive story you want to create...",
    newLabel: "New story",
  },
  "godot-game": {
    page: "godot",
    title: "What are we building in Godot?",
    placeholder: "Describe the Godot game you want to create...",
    newLabel: "New Godot project",
  },
} as const;

export function recentStudioProjects(
  projects: readonly ProjectState[],
  type: GameStudioType,
  limit = 4,
): ProjectState[] {
  return projects
    .filter((project) => project.type === type)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}
