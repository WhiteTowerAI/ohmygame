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

// Keep the pool and order stable so existing projects retain their identity.
const symbols = [
  PlanetIcon,
  LeafIcon,
  GhostSmileIcon,
  CompassIcon,
  CatIcon,
  RocketIcon,
  CupHotIcon,
  GamepadIcon,
  MoonIcon,
  BalloonIcon,
  BookIcon,
  PaletteIcon,
  CloudSunIcon,
  CrownIcon,
  MusicNoteIcon,
  BoxIcon,
  CameraIcon,
  StarIcon,
  UfoIcon,
  SunIcon,
  LightbulbIcon,
  UmbrellaIcon,
  GlobalIcon,
  FireIcon,
];

export function ProjectPlaceholder({ projectId }: { projectId: string }) {
  let hash = 2166136261;
  for (const character of projectId)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  const Symbol = symbols[hash % symbols.length]!;
  const tone = (hash >>> 16) % 4;
  return (
    <span
      className="project-cover-placeholder"
      style={{
        background: `var(--project-cover-bg-${tone})`,
      }}
    >
      <Symbol size={38} aria-hidden="true" />
    </span>
  );
}
