import type { ProjectAppearance } from "./contracts.js";

/**
 * The default icon library, in the order a project without a chosen icon
 * picks from by its ID. Keep the order stable so existing projects keep theirs.
 */
export const PROJECT_ICONS = [
  "planet", "leaf", "ghost", "compass", "cat", "rocket", "cup", "gamepad",
  "moon", "balloon", "book", "palette", "cloud-sun", "crown", "music", "box",
  "camera", "star", "ufo", "sun", "lightbulb", "umbrella", "globe", "fire",
] as const;

export type ProjectIcon = (typeof PROJECT_ICONS)[number];

/** How many background tones the default template has. */
export const PROJECT_TONES = 4;

/** The appearance as saved, or undefined when it holds anything unknown. */
export function parseProjectAppearance(value: unknown): ProjectAppearance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { icon, tone, cover, logo, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) return undefined;
  if (icon !== undefined && !PROJECT_ICONS.includes(icon as ProjectIcon)) return undefined;
  if (tone !== undefined && !(Number.isInteger(tone) && (tone as number) >= 0 && (tone as number) < PROJECT_TONES)) return undefined;
  if (cover !== undefined && cover !== "template") return undefined;
  if (logo !== undefined && logo !== true) return undefined;
  return {
    ...(icon !== undefined ? { icon: icon as ProjectIcon } : {}),
    ...(tone !== undefined ? { tone: tone as number } : {}),
    ...(cover === "template" ? { cover: "template" as const } : {}),
    ...(logo === true ? { logo: true as const } : {}),
  };
}

/** The icon and tone a project shows: its own choice, or one picked from its ID. */
export function projectSymbol(projectId: string, appearance?: ProjectAppearance): { icon: ProjectIcon; tone: number } {
  let hash = 2166136261;
  for (const character of projectId)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return {
    icon: appearance?.icon ?? PROJECT_ICONS[hash % PROJECT_ICONS.length]!,
    tone: appearance?.tone ?? (hash >>> 16) % PROJECT_TONES,
  };
}
