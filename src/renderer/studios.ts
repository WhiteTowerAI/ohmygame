import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { t } from "./i18n.js";

export type GameStudioType = Exclude<ProjectType, "asset-canvas">;

export const GAME_STUDIOS = {
  general: {
    page: "general",
    title: t("studio.general.title"),
    placeholder: t("studio.general.placeholder"),
    newLabel: t("studio.general.new"),
  },
  "web-game": {
    page: "web-game",
    title: t("studio.web.title"),
    placeholder: t("studio.web.placeholder"),
    newLabel: t("studio.web.new"),
  },
  "interactive-story": {
    page: "interactive-story",
    title: t("studio.story.title"),
    placeholder: t("studio.story.placeholder"),
    newLabel: t("studio.story.new"),
  },
  "godot-game": {
    page: "godot",
    title: t("studio.godot.title"),
    placeholder: t("studio.godot.placeholder"),
    newLabel: t("studio.godot.new"),
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
