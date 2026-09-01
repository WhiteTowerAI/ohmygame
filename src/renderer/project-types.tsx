import { Clapperboard, Globe2 } from "./icons.js";
import type { ProjectType } from "../shared/contracts.js";

export const PROJECT_TYPES = [
  { label: "Web Game", value: "web-game" },
  { label: "Interactive Drama", value: "interactive-drama" },
  { label: "Godot", value: "godot-game" },
] as const satisfies ReadonlyArray<{ label: string; value: ProjectType }>;

export function ProjectTypeIcon({ type, size = 14 }: { type: ProjectType; size?: number }) {
  if (type === "web-game") return <Globe2 size={size} aria-hidden="true" />;
  if (type === "interactive-drama") return <Clapperboard size={size} aria-hidden="true" />;
  return <span className="project-type-godot-icon" style={{ width: size, height: size }} aria-hidden="true" />;
}

export function projectTypeLabel(type: ProjectType): string {
  return PROJECT_TYPES.find((option) => option.value === type)?.label ?? type;
}

export function defaultProjectName(type: ProjectType): string {
  return type === "interactive-drama" ? "Untitled drama" : "Untitled project";
}
