import { Clapperboard, Globe2, Image } from "./icons.js";
import type { ProjectType } from "../shared/contracts.js";
export { defaultProjectName } from "../shared/project-names.js";

export interface ProjectTypeOption {
  label: string;
  value: ProjectType;
}

export const PROJECT_TYPES = [
  { label: "Web Game", value: "web-game" },
  { label: "Interactive Drama", value: "interactive-drama" },
  { label: "Asset Canvas", value: "asset-canvas" },
  { label: "Godot", value: "godot-game" },
] as const satisfies readonly ProjectTypeOption[];

export const GAME_PROJECT_TYPES: readonly ProjectTypeOption[] = PROJECT_TYPES.filter(({ value }) => value !== "asset-canvas");

export function ProjectTypeIcon({ type, size = 14 }: { type: ProjectType; size?: number }) {
  if (type === "web-game") return <Globe2 size={size} aria-hidden="true" />;
  if (type === "interactive-drama") return <Clapperboard size={size} aria-hidden="true" />;
  if (type === "asset-canvas") return <Image size={size} aria-hidden="true" />;
  return <span className="project-type-godot-icon" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function projectTypeLabel(type: ProjectType): string {
  return PROJECT_TYPES.find((option) => option.value === type)?.label ?? type;
}
