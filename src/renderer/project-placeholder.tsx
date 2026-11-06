import {
  BalloonIcon,
  BookIcon,
  BoxIcon,
  CameraIcon,
  CatIcon,
  CloudSunIcon,
  CompassIcon,
  CrownIcon,
  CupHotIcon,
  FireIcon,
  GamepadIcon,
  GhostSmileIcon,
  GlobalIcon,
  LeafIcon,
  LightbulbIcon,
  MoonIcon,
  MusicNoteIcon,
  PaletteIcon,
  PlanetIcon,
  RocketIcon,
  StarIcon,
  SunIcon,
  UfoIcon,
  UmbrellaIcon,
} from "@solar-icons/react/linear";
import type { ComponentType } from "react";
import type { ProjectAppearance } from "../shared/contracts.js";
import { projectSymbol, type ProjectIcon } from "../shared/project-appearance.js";

/** The default icon library, by the names projects save. */
export const PROJECT_ICON_SYMBOLS: Record<ProjectIcon, ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" }>> = {
  planet: PlanetIcon,
  leaf: LeafIcon,
  ghost: GhostSmileIcon,
  compass: CompassIcon,
  cat: CatIcon,
  rocket: RocketIcon,
  cup: CupHotIcon,
  gamepad: GamepadIcon,
  moon: MoonIcon,
  balloon: BalloonIcon,
  book: BookIcon,
  palette: PaletteIcon,
  "cloud-sun": CloudSunIcon,
  crown: CrownIcon,
  music: MusicNoteIcon,
  box: BoxIcon,
  camera: CameraIcon,
  star: StarIcon,
  ufo: UfoIcon,
  sun: SunIcon,
  lightbulb: LightbulbIcon,
  umbrella: UmbrellaIcon,
  globe: GlobalIcon,
  fire: FireIcon,
};

/** The default template: a project's icon centred on its background tone. */
export function ProjectPlaceholder({ projectId, appearance, size = 38 }: { projectId: string; appearance?: ProjectAppearance; size?: number }) {
  const { icon, tone } = projectSymbol(projectId, appearance);
  const Symbol = PROJECT_ICON_SYMBOLS[icon];
  return (
    <span
      className="project-cover-placeholder"
      style={{
        background: `var(--project-cover-bg-${tone})`,
      }}
    >
      <Symbol size={size} aria-hidden="true" />
    </span>
  );
}
