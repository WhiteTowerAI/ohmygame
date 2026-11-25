import {
  Balloon,
  Book,
  Box,
  Camera,
  Cat,
  CloudSun,
  Compass,
  Crown,
  CupHot,
  Fire,
  Gamepad2,
  GhostSmile,
  Globe2,
  Leaf,
  Lightbulb,
  Moon,
  Music2,
  Palette,
  Planet,
  Rocket,
  Star,
  Sun,
  Ufo,
  Umbrella,
  type IconComponent,
} from "./icons.js";
import type { ProjectAppearance } from "../shared/contracts.js";
import { projectSymbol, type ProjectIcon } from "../shared/project-appearance.js";

/** The default icon library, by the names projects save. */
export const PROJECT_ICON_SYMBOLS: Record<ProjectIcon, IconComponent> = {
  planet: Planet,
  leaf: Leaf,
  ghost: GhostSmile,
  compass: Compass,
  cat: Cat,
  rocket: Rocket,
  cup: CupHot,
  gamepad: Gamepad2,
  moon: Moon,
  balloon: Balloon,
  book: Book,
  palette: Palette,
  "cloud-sun": CloudSun,
  crown: Crown,
  music: Music2,
  box: Box,
  camera: Camera,
  star: Star,
  ufo: Ufo,
  sun: Sun,
  lightbulb: Lightbulb,
  umbrella: Umbrella,
  globe: Globe2,
  fire: Fire,
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
